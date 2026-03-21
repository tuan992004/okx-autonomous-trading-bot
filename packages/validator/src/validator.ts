import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
    createLogger,
    getAnthropicClient,
    cachedBlock,
    dynamicBlock,
    extractUsageRecord,
    withRetry,
    ABSOLUTE_LIMITS,
} from '@okx-bot/shared';
import type {
    TradeDecision,
    ValidationResult,
    RiskConfig,
    StrategyConfig,
    ApiUsageRecord,
} from '@okx-bot/shared';
import { ValidationResultSchema } from '@okx-bot/shared';
import type { StateManager } from '@okx-bot/state';
import { buildValidatorSystemPrompt, buildValidatorUserMessage } from './prompts.js';

const logger = createLogger('validator');

export interface ValidateResult {
    validation: ValidationResult;
    usage: ApiUsageRecord | null;
}

/**
 * Risk validator that acts as a hard gate before any order fires.
 * 
 * CRITICAL: Two layers of validation:
 * 1. Hardcoded code-level checks (ABSOLUTE_LIMITS) — NEVER delegated to LLM
 * 2. Haiku-based rule checking against risk.toml config
 */
export class RiskValidator {
    private client: Anthropic;
    private riskConfig: RiskConfig;
    private strategyConfig: StrategyConfig;
    private state: StateManager;
    private validatorPrompt: string;

    constructor(riskConfig: RiskConfig, strategyConfig: StrategyConfig, state: StateManager) {
        this.client = getAnthropicClient();
        this.riskConfig = riskConfig;
        this.strategyConfig = strategyConfig;
        this.state = state;
        this.validatorPrompt = buildValidatorSystemPrompt(riskConfig);
    }

    /**
     * Validate a trade decision. Returns approved: false if ANY check fails.
     * Code-level checks run FIRST (no LLM needed for absolute limits).
     */
    async validate(decision: TradeDecision, cycleId: string): Promise<ValidateResult> {
        logger.info('Starting risk validation', {
            cycleId,
            data: {
                action: decision.action,
                instrument: decision.instrument,
                size: decision.size,
                price: decision.price,
            },
        });

        // ── Resolve market order price ──────────────────────────────────────
        // Market orders may lack a price. Fetch live ticker so the validator
        // can compute an accurate USDT value before checking limits.
        let resolvedDecision = decision;
        if (decision.action !== 'SKIP' && decision.orderType === 'market' && !decision.price) {
            const livePrice = await this.fetchLivePrice(decision.instrument, cycleId);
            if (livePrice) {
                resolvedDecision = { ...decision, price: livePrice };
                logger.info('Resolved market order price from live ticker', {
                    cycleId,
                    data: { instrument: decision.instrument, livePrice },
                });
            }
        }

        // ── Layer 1: Hardcoded code-level checks (no LLM) ──────────────────

        const codeCheckResult = this.runCodeLevelChecks(resolvedDecision, cycleId);
        if (!codeCheckResult.approved) {
            logger.warn('Trade REJECTED by code-level safety check', {
                cycleId,
                data: { reason: codeCheckResult.reason },
            });
            return { validation: codeCheckResult, usage: null };
        }

        // ── Layer 2: Haiku-based validation ─────────────────────────────────

        try {
            const llmResult = await this.runLlmValidation(resolvedDecision, cycleId);
            return llmResult;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('LLM validation failed — REJECTING as safety fallback', {
                cycleId,
                data: { error: msg },
            });
            return {
                validation: {
                    approved: false,
                    reason: `LLM validation failed: ${msg}. Rejecting as safety fallback.`,
                },
                usage: null,
            };
        }
    }

    /**
     * Layer 1: Hardcoded safety checks enforced in code.
     * These NEVER rely on LLM output.
     */
    private runCodeLevelChecks(decision: TradeDecision, cycleId: string): ValidationResult {
        const checkedRules: string[] = [];

        // Skip action
        if (decision.action === 'SKIP') {
            return { approved: true, reason: 'SKIP action — no trade to validate', checkedRules: ['action-type'] };
        }

        // 1. Max single order size
        checkedRules.push('max-single-order');
        if (!decision.price && decision.orderType === 'market') {
            return {
                approved: false,
                reason: 'Cannot validate market order: live price unavailable. Rejecting for safety.',
                checkedRules,
            };
        }
        const effectiveValue = decision.size * (decision.price ?? 0);
        if (effectiveValue > ABSOLUTE_LIMITS.maxSingleOrderUSDT) {
            return {
                approved: false,
                reason: `Order value ${effectiveValue.toFixed(2)} USDT exceeds absolute limit of ${ABSOLUTE_LIMITS.maxSingleOrderUSDT} USDT`,
                checkedRules,
            };
        }

        // 2. Allowed instrument types
        checkedRules.push('instrument-type');
        const instType = decision.instrument.endsWith('-SWAP') ? 'SWAP' : 'SPOT';
        if (!(ABSOLUTE_LIMITS.allowedInstrumentTypes as readonly string[]).includes(instType)) {
            return {
                approved: false,
                reason: `Instrument type "${instType}" is not allowed. Allowed: ${ABSOLUTE_LIMITS.allowedInstrumentTypes.join(', ')}`,
                checkedRules,
            };
        }

        // 3. Forbidden instruments
        checkedRules.push('forbidden-instruments');
        if (this.riskConfig.forbidden.instruments.includes(decision.instrument)) {
            return {
                approved: false,
                reason: `Instrument "${decision.instrument}" is in the forbidden list`,
                checkedRules,
            };
        }

        // 4. Max total exposure
        checkedRules.push('max-total-exposure');
        const currentExposure = this.state.getTotalExposureUsd();
        if (currentExposure + effectiveValue > ABSOLUTE_LIMITS.maxTotalExposureUSDT) {
            return {
                approved: false,
                reason: `Adding ${effectiveValue.toFixed(2)} USDT would exceed total exposure limit. Current: ${currentExposure.toFixed(2)}, Max: ${ABSOLUTE_LIMITS.maxTotalExposureUSDT}`,
                checkedRules,
            };
        }

        // 5. Daily loss kill switch
        checkedRules.push('daily-loss-limit');
        const dailyLoss = this.state.getDailyLoss();
        if (dailyLoss >= ABSOLUTE_LIMITS.maxDailyLossUSDT) {
            return {
                approved: false,
                reason: `Daily loss of ${dailyLoss.toFixed(2)} USDT has reached the absolute limit of ${ABSOLUTE_LIMITS.maxDailyLossUSDT} USDT. Trading locked.`,
                checkedRules,
            };
        }

        // 6. Trading locked
        checkedRules.push('trading-lock');
        if (this.state.isTradingLocked()) {
            return {
                approved: false,
                reason: 'Trading is currently locked (kill switch or cooldown active)',
                checkedRules,
            };
        }

        // 7. Duplicate order detection
        checkedRules.push('duplicate-order');
        const side = decision.action === 'BUY' ? 'buy' : 'sell';
        if (this.state.checkDuplicateOrder(decision.instrument, side, 5)) {
            return {
                approved: false,
                reason: `Duplicate order detected: ${side} ${decision.instrument} within last 5 minutes`,
                checkedRules,
            };
        }

        // 8. Max open positions
        checkedRules.push('max-open-positions');
        const openPositionCount = this.state.getOpenPositionCount();
        if (decision.action === 'BUY' && openPositionCount >= this.riskConfig.limits.max_open_positions) {
            return {
                approved: false,
                reason: `Max open positions (${this.riskConfig.limits.max_open_positions}) reached. Currently: ${openPositionCount}`,
                checkedRules,
            };
        }

        // 9. Kill switch: consecutive losses
        checkedRules.push('consecutive-losses');
        if (this.riskConfig.killswitch.enabled) {
            const consecutiveLosses = this.state.getConsecutiveLosses();
            if (consecutiveLosses >= this.riskConfig.killswitch.consecutive_loss_count) {
                // Lock trading with cooldown
                const cooldownEnd = new Date(
                    Date.now() + this.riskConfig.killswitch.cooldown_minutes * 60 * 1000,
                ).toISOString();
                this.state.lockTradingForDay(cooldownEnd);
                return {
                    approved: false,
                    reason: `Kill switch triggered: ${consecutiveLosses} consecutive losses. Cooldown: ${this.riskConfig.killswitch.cooldown_minutes} minutes.`,
                    checkedRules,
                };
            }
        }

        return { approved: true, reason: 'All code-level checks passed', checkedRules };
    }

    /**
     * Fetch the current mid-price from OKX for a given instrument.
     * Returns null if the fetch fails (caller should handle gracefully).
     */
    private async fetchLivePrice(instId: string, cycleId: string): Promise<number | null> {
        try {
            const profile = process.env['OKX_PROFILE'] ?? 'demo';
            const { stdout } = await execFileAsync('okx', [
                '--profile', profile, '--json',
                'market', 'ticker', instId,
            ], { timeout: 10000 });

            const ticker = JSON.parse(stdout) as Record<string, string>;
            const bid = parseFloat(ticker['bidPx'] ?? '0');
            const ask = parseFloat(ticker['askPx'] ?? '0');
            if (bid > 0 && ask > 0) {
                return (bid + ask) / 2;
            }
            return parseFloat(ticker['last'] ?? '0') || null;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn('Failed to fetch live price for market order validation', {
                cycleId,
                data: { instrument: instId, error: msg },
            });
            return null;
        }
    }

    /**
     * Layer 2: LLM-based validation using Claude Haiku.
     * Checks more nuanced rules that benefit from LLM reasoning.
     */
    private async runLlmValidation(decision: TradeDecision, cycleId: string): Promise<ValidateResult> {
        const accountState = {
            openPositions: this.state.getOpenPositions(),
            openPositionCount: this.state.getOpenPositionCount(),
            totalExposureUsd: this.state.getTotalExposureUsd(),
            dailyLoss: this.state.getDailyLoss(),
            dailyStats: this.state.getDailyStats(),
            consecutiveLosses: this.state.getConsecutiveLosses(),
        };

        const tradeDetails = {
            action: decision.action,
            instrument: decision.instrument,
            size: decision.size,
            price: decision.price,
            stopLoss: decision.stopLoss,
            takeProfit: decision.takeProfit,
            orderType: decision.orderType,
            reasoning: decision.reasoning,
        };

        const userMessage = buildValidatorUserMessage(tradeDetails, accountState);

        const response = await withRetry(
            () =>
                this.client.messages.create({
                    model: this.strategyConfig.models.validator,
                    max_tokens: 300,
                    system: [cachedBlock(this.validatorPrompt) as Anthropic.TextBlockParam],
                    messages: [
                        {
                            role: 'user',
                            content: [dynamicBlock(userMessage) as Anthropic.TextBlockParam],
                        },
                    ],
                }),
            { context: 'Validator Haiku call', maxRetries: 1 },
        );

        const usage = extractUsageRecord(response, 'validator', cycleId);

        // Parse response
        const textBlock = response.content.find(
            (block): block is Anthropic.TextBlock => block.type === 'text',
        );

        if (!textBlock) {
            return {
                validation: { approved: false, reason: 'No response from validator LLM' },
                usage,
            };
        }

        try {
            const parsed = JSON.parse(textBlock.text) as unknown;
            const result = ValidationResultSchema.safeParse(parsed);

            if (!result.success) {
                logger.warn('Invalid validator response format — rejecting as safety fallback', {
                    cycleId,
                    data: { raw: textBlock.text.slice(0, 500) },
                });
                return {
                    validation: { approved: false, reason: 'Invalid validator response format — rejecting as safety fallback' },
                    usage,
                };
            }

            if (result.data.approved) {
                logger.info('Trade APPROVED by risk validator', { cycleId, data: { checkedRules: result.data.checkedRules } });
            } else {
                logger.warn('Trade REJECTED by risk validator', { cycleId, data: { reason: result.data.reason } });
            }

            return { validation: result.data, usage };
        } catch {
            return {
                validation: { approved: false, reason: 'Failed to parse validator response — rejecting as safety fallback' },
                usage,
            };
        }
    }
}
