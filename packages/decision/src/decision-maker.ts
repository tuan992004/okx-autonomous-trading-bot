import Anthropic from '@anthropic-ai/sdk';
import {
    createLogger,
    getAnthropicClient,
    cachedBlock,
    dynamicBlock,
    extractUsageRecord,
    withRetry,
    DECISION_LIMITS,
} from '@okx-bot/shared';
import type { Signal, TradeDecision, StrategyConfig, ApiUsageRecord } from '@okx-bot/shared';
import { TradeDecisionSchema } from '@okx-bot/shared';
import { OKX_READ_TOOLS, executeToolCall } from './tools.js';

const logger = createLogger('decision');

const DECISION_SYSTEM_PROMPT = `You are a professional crypto trading strategy executor. You analyze market signals and account state to make informed trading decisions.

RULES:
1. You have access to OKX market data tools. Use them to gather additional context.
2. After analyzing, you MUST output a final trade decision as a JSON tool call to 'submit_decision'.
3. You can only READ market data — you cannot place orders directly.
4. Be conservative. Only trade when the signal is clear and the risk/reward is favorable.
5. Always consider current positions to avoid overexposure.
6. Set appropriate stop-loss and take-profit levels.

DECISION FORMAT (call submit_decision with):
{
  "action": "BUY" | "SELL" | "CLOSE" | "SKIP",
  "instrument": "<instrument ID>",
  "size": <size in base currency or contracts>,
  "price": <limit price or null for market>,
  "stopLoss": <stop loss price>,
  "takeProfit": <take profit price>,
  "orderType": "market" | "limit" | "post_only",
  "reasoning": "<detailed explanation of your decision>"
}

If the signal is weak or conditions are unfavorable, choose action "SKIP" with reasoning.`;

const SUBMIT_DECISION_TOOL: Anthropic.Tool = {
    name: 'submit_decision',
    description: 'Submit your final trading decision after analysis. Call this exactly once when you have made your decision.',
    input_schema: {
        type: 'object' as const,
        properties: {
            action: { type: 'string', enum: ['BUY', 'SELL', 'CLOSE', 'SKIP'], description: 'Trade action' },
            instrument: { type: 'string', description: 'Instrument ID' },
            size: { type: 'number', description: 'Order size' },
            price: { type: 'number', description: 'Limit price (omit for market orders)' },
            stopLoss: { type: 'number', description: 'Stop loss price' },
            takeProfit: { type: 'number', description: 'Take profit price' },
            orderType: { type: 'string', enum: ['market', 'limit', 'post_only'], description: 'Order type' },
            reasoning: { type: 'string', description: 'Detailed reasoning for the decision' },
        },
        required: ['action', 'instrument', 'size', 'orderType', 'reasoning'],
    },
};

export interface DecisionResult {
    decision: TradeDecision;
    usageRecords: ApiUsageRecord[];
}

/**
 * Strategy decision maker powered by Claude Sonnet.
 * Uses an agentic tool loop to gather market context and make decisions.
 */
export class StrategyDecisionMaker {
    private client: Anthropic;
    private config: StrategyConfig;
    private tools: Anthropic.Tool[];

    constructor(config: StrategyConfig) {
        this.client = getAnthropicClient();
        this.config = config;
        this.tools = [...OKX_READ_TOOLS, SUBMIT_DECISION_TOOL];
    }

    /**
     * Analyze a signal and make a trade decision using an agentic loop.
     */
    async decide(signal: Signal, cycleId: string): Promise<DecisionResult> {
        const usageRecords: ApiUsageRecord[] = [];
        const modelId = this.config.models.use_opus_for_complex
            ? 'claude-opus-4-6-20250514'
            : this.config.models.decision;

        logger.info('Starting decision analysis', {
            cycleId,
            model: modelId,
            data: {
                signal: {
                    type: signal.type,
                    instrument: signal.instrument,
                    direction: signal.direction,
                    confidence: signal.confidence,
                },
            },
        });

        const userPrompt = `A trading signal has been detected. Analyze it and make a decision.

SIGNAL:
- Type: ${signal.type}
- Instrument: ${signal.instrument}
- Direction: ${signal.direction}
- Confidence: ${signal.confidence}
- Data: ${JSON.stringify(signal.data)}

Use the available tools to gather current market context (ticker, orderbook, account balance, positions), then submit your decision.`;

        // Initialize the conversation
        const messages: Anthropic.MessageParam[] = [
            {
                role: 'user',
                content: [
                    cachedBlock(JSON.stringify(this.tools.map((t) => ({ name: t.name, desc: t.description })))) as Anthropic.TextBlockParam,
                    dynamicBlock(userPrompt) as Anthropic.TextBlockParam,
                ],
            },
        ];

        let toolCallCount = 0;
        let decision: TradeDecision | null = null;
        let thinkingContent = '';

        // Agentic loop
        for (let round = 0; round < DECISION_LIMITS.maxToolCallRounds; round++) {
            const response = await withRetry(
                () =>
                    this.client.messages.create({
                        model: modelId,
                        max_tokens: DECISION_LIMITS.maxOutputTokens,
                        system: [cachedBlock(DECISION_SYSTEM_PROMPT) as Anthropic.TextBlockParam],
                        tools: this.tools,
                        messages,
                    }),
                { context: `Decision round ${round + 1}`, maxRetries: 2 },
            );

            const usage = extractUsageRecord(response, 'decision', cycleId);
            usageRecords.push(usage);

            logger.info(`Decision round ${round + 1}`, {
                cycleId,
                model: usage.model,
                tokensUsed: usage.inputTokens,
                cachedTokens: usage.cachedTokens,
                estimatedCostUSD: usage.costUsd,
                data: { stopReason: response.stop_reason },
            });

            // Extract thinking content if present
            for (const block of response.content) {
                if (block.type === 'thinking') {
                    thinkingContent += (block as Anthropic.ThinkingBlock).thinking + '\n';
                }
            }

            // Check for tool use
            const toolUseBlocks = response.content.filter(
                (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
            );

            if (toolUseBlocks.length === 0) {
                // Model stopped without calling any tools — try to extract decision from text
                const textBlock = response.content.find(
                    (b): b is Anthropic.TextBlock => b.type === 'text',
                );
                logger.warn('Model stopped without tool calls', {
                    cycleId,
                    data: { text: textBlock?.text?.slice(0, 300) },
                });
                break;
            }

            // Process tool calls
            const toolResults: Anthropic.ToolResultBlockParam[] = [];

            for (const toolUse of toolUseBlocks) {
                toolCallCount++;

                if (toolUse.name === 'submit_decision') {
                    // Final decision submitted
                    const input = toolUse.input as Record<string, unknown>;
                    const parseResult = TradeDecisionSchema.safeParse({
                        ...input,
                        model: modelId,
                        thinkingContent: thinkingContent || undefined,
                        toolCallCount,
                    });

                    if (parseResult.success) {
                        decision = parseResult.data;
                        logger.info('Decision submitted', {
                            cycleId,
                            data: {
                                action: decision.action,
                                instrument: decision.instrument,
                                size: decision.size,
                                reasoning: decision.reasoning.slice(0, 200),
                            },
                        });
                    } else {
                        logger.error('Invalid decision format', {
                            cycleId,
                            data: { errors: parseResult.error.issues, raw: input },
                        });
                    }

                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content: 'Decision received.',
                    });
                    break;
                }

                // Execute read-only tool
                logger.info(`Executing tool: ${toolUse.name}`, {
                    cycleId,
                    data: { input: toolUse.input },
                });

                const toolResult = await executeToolCall(
                    toolUse.name,
                    toolUse.input as Record<string, unknown>,
                );

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: toolResult.slice(0, 4000), // Limit result size
                });
            }

            if (decision) break;

            // Add assistant response and tool results to conversation
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: toolResults });
        }

        if (!decision) {
            logger.warn('Decision maker did not produce a decision — defaulting to SKIP', { cycleId });
            decision = {
                action: 'SKIP',
                instrument: signal.instrument,
                size: 0,
                orderType: 'market',
                reasoning: 'Decision maker failed to produce a valid decision within tool call limit',
                model: modelId,
                toolCallCount,
            };
        }

        return { decision, usageRecords };
    }
}
