import Anthropic from '@anthropic-ai/sdk';
import { calculateCostUsd, MODEL_PRICING } from './constants.js';
import { createLogger } from './logger.js';
import type { ApiUsageRecord, ComponentName } from './types.js';

const logger = createLogger('orchestrator');

let clientInstance: Anthropic | null = null;

/**
 * Get or create the singleton Anthropic client.
 */
export function getAnthropicClient(): Anthropic {
    if (!clientInstance) {
        const apiKey = process.env['ANTHROPIC_API_KEY'];
        if (!apiKey) {
            throw new Error(
                'ANTHROPIC_API_KEY environment variable is required. ' +
                'Copy .env.example to .env and add your API key.',
            );
        }
        clientInstance = new Anthropic({ apiKey });
    }
    return clientInstance;
}

/**
 * Message content block with optional cache control.
 */
export interface CacheableTextBlock {
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
}

/**
 * Create a text block with prompt caching enabled.
 */
export function cachedBlock(text: string): CacheableTextBlock {
    return {
        type: 'text',
        text,
        cache_control: { type: 'ephemeral' },
    };
}

/**
 * Create a text block WITHOUT caching (for dynamic content).
 */
export function dynamicBlock(text: string): CacheableTextBlock {
    return {
        type: 'text',
        text,
    };
}

/**
 * Extract API usage tracking from an Anthropic response.
 */
export function extractUsageRecord(
    response: Anthropic.Message,
    component: ComponentName,
    cycleId: string,
): ApiUsageRecord {
    const usage = response.usage;
    const model = response.model;

    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTokens = (usage as any).cache_read_input_tokens ?? 0;

    const costUsd = calculateCostUsd(model, inputTokens, cachedTokens, outputTokens);

    return {
        cycleId,
        component,
        model,
        inputTokens,
        cachedTokens: cachedTokens as number,
        outputTokens,
        costUsd,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Retry wrapper for Anthropic API calls with exponential backoff.
 * Handles overload (529) and server errors (500+).
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: { maxRetries?: number; baseDelayMs?: number; context?: string } = {},
): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 1000;
    const context = options.context ?? 'API call';

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: unknown) {
            lastError = error instanceof Error ? error : new Error(String(error));

            if (attempt === maxRetries) {
                break;
            }

            // Check if error is retryable
            const isOverload = lastError.message.includes('529') || lastError.message.includes('overloaded');
            const isServerError = lastError.message.includes('500') || lastError.message.includes('502');
            const isTimeout = lastError.message.includes('timeout') || lastError.message.includes('ETIMEDOUT');

            if (!isOverload && !isServerError && !isTimeout) {
                throw lastError; // Non-retryable error
            }

            const delay = baseDelayMs * Math.pow(2, attempt);
            logger.warn(`${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`, {
                error: lastError.message,
            });
            await sleep(delay);
        }
    }

    throw lastError;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a model string is valid (has known pricing).
 */
export function isKnownModel(model: string): boolean {
    return model in MODEL_PRICING;
}
