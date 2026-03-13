import Anthropic from '@anthropic-ai/sdk';
import {
    createLogger,
    getAnthropicClient,
    cachedBlock,
    dynamicBlock,
    extractUsageRecord,
    withRetry,
    SCANNER_TOKEN_LIMITS,
} from '@okx-bot/shared';
import type { Signal, StrategyConfig, ApiUsageRecord } from '@okx-bot/shared';
import { SignalSchema } from '@okx-bot/shared';
import { buildScannerSystemPrompt, buildScannerUserMessage } from './prompts.js';
import { MarketDataFetcher } from './market-data.js';

const logger = createLogger('scanner');

export interface ScanResult {
    signal: Signal | null;
    usage: ApiUsageRecord;
}

/**
 * Market scanner powered by Claude Haiku.
 * Polls market data and sends to Haiku for signal detection.
 * Uses prompt caching: system prompt + signal criteria are cached.
 */
export class MarketScanner {
    private client: Anthropic;
    private fetcher: MarketDataFetcher;
    private config: StrategyConfig;
    private systemPrompt: string;

    constructor(config: StrategyConfig) {
        this.client = getAnthropicClient();
        this.fetcher = new MarketDataFetcher();
        this.config = config;
        this.systemPrompt = buildScannerSystemPrompt(config);
    }

    /**
     * Run a single scan cycle across all configured instruments.
     */
    async scan(cycleId: string): Promise<ScanResult> {
        const instruments = [
            ...this.config.instruments.spot,
            ...this.config.instruments.swap,
        ];

        logger.info('Starting market scan', {
            cycleId,
            instruments,
            data: { instrumentCount: instruments.length },
        });

        // Fetch market data for all instruments in parallel
        const snapshots: Record<string, unknown> = {};
        const fetchPromises = instruments.map(async (instId) => {
            try {
                const snapshot = await this.fetcher.getSnapshot(instId);
                snapshots[instId] = {
                    ticker: {
                        last: snapshot.ticker.last,
                        bid: snapshot.ticker.bidPx,
                        ask: snapshot.ticker.askPx,
                        vol24h: snapshot.ticker.vol24h,
                    },
                    indicators: snapshot.computedIndicators,
                    fundingRate: snapshot.fundingRate
                        ? { rate: snapshot.fundingRate.fundingRate, nextRate: snapshot.fundingRate.nextFundingRate }
                        : null,
                    recentCandles: snapshot.candles.slice(0, 5).map((c) => ({
                        close: c.close,
                        vol: c.vol,
                        high: c.high,
                        low: c.low,
                    })),
                };
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.warn(`Failed to fetch data for ${instId}`, { cycleId, data: { error: msg } });
            }
        });

        await Promise.all(fetchPromises);

        if (Object.keys(snapshots).length === 0) {
            logger.warn('No market data fetched for any instrument', { cycleId });
            return {
                signal: null,
                usage: this.emptyUsage(cycleId),
            };
        }

        // Call Haiku with prompt caching
        const userMessage = buildScannerUserMessage(snapshots);

        const response = await withRetry(
            () =>
                this.client.messages.create({
                    model: this.config.models.scanner,
                    max_tokens: SCANNER_TOKEN_LIMITS.maxOutputTokens,
                    system: [cachedBlock(this.systemPrompt) as Anthropic.TextBlockParam],
                    messages: [
                        {
                            role: 'user',
                            content: [dynamicBlock(userMessage) as Anthropic.TextBlockParam],
                        },
                    ],
                }),
            { context: 'Scanner Haiku call', maxRetries: 2 },
        );

        const usage = extractUsageRecord(response, 'scanner', cycleId);

        logger.info('Scanner API call completed', {
            cycleId,
            model: usage.model,
            tokensUsed: usage.inputTokens,
            cachedTokens: usage.cachedTokens,
            estimatedCostUSD: usage.costUsd,
        });

        // Parse response
        const signal = this.parseSignalResponse(response, cycleId);
        return { signal, usage };
    }

    /**
     * Parse the Haiku response and extract a Signal if present.
     */
    private parseSignalResponse(response: Anthropic.Message, cycleId: string): Signal | null {
        const textBlock = response.content.find(
            (block): block is Anthropic.TextBlock => block.type === 'text',
        );

        if (!textBlock) {
            logger.warn('No text content in scanner response', { cycleId });
            return null;
        }

        try {
            const parsed = JSON.parse(textBlock.text) as { signal: unknown };

            if (!parsed.signal || parsed.signal === null) {
                logger.info('No signal detected', { cycleId });
                return null;
            }

            // Validate with Zod
            const result = SignalSchema.safeParse({
                ...parsed.signal as Record<string, unknown>,
                timestamp: new Date().toISOString(),
            });

            if (!result.success) {
                logger.warn('Invalid signal format from scanner', {
                    cycleId,
                    data: { errors: result.error.issues, rawSignal: parsed.signal },
                });
                return null;
            }

            logger.info('Signal detected', {
                cycleId,
                data: {
                    type: result.data.type,
                    instrument: result.data.instrument,
                    direction: result.data.direction,
                    confidence: result.data.confidence,
                },
            });

            return result.data;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('Failed to parse scanner response', {
                cycleId,
                data: { error: msg, raw: textBlock.text.slice(0, 500) },
            });
            return null;
        }
    }

    private emptyUsage(cycleId: string): ApiUsageRecord {
        return {
            cycleId,
            component: 'scanner',
            model: this.config.models.scanner,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            timestamp: new Date().toISOString(),
        };
    }
}
