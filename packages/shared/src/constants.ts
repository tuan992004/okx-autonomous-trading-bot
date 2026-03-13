/**
 * Hardcoded absolute safety limits — NEVER overridable by config or LLM output.
 * These are enforced in code before any order is sent.
 */
export const ABSOLUTE_LIMITS = {
    maxSingleOrderUSDT: 1000,
    maxTotalExposureUSDT: 5000,
    maxDailyLossUSDT: 200,
    allowedInstrumentTypes: ['SPOT', 'SWAP'] as const,
} as const;

/**
 * Model pricing in USD per million tokens (as of 2026-03).
 * Used for cost estimation logging.
 */
export const MODEL_PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
    'claude-haiku-4-5-20251001': {
        input: 0.80,
        cachedInput: 0.08,
        output: 4.00,
    },
    'claude-sonnet-4-6-20250514': {
        input: 3.00,
        cachedInput: 0.30,
        output: 15.00,
    },
    'claude-opus-4-6-20250514': {
        input: 15.00,
        cachedInput: 1.50,
        output: 75.00,
    },
};

/**
 * Scanner token limits — enforced hard caps.
 */
export const SCANNER_TOKEN_LIMITS = {
    maxCachedInputTokens: 2000,
    maxOutputTokens: 500,
} as const;

/**
 * Decision maker limits.
 */
export const DECISION_LIMITS = {
    maxToolCallRounds: 10,
    thinkingBudgetTokens: 5000,
    maxOutputTokens: 4096,
} as const;

/**
 * Calculate estimated USD cost for an API call.
 */
export function calculateCostUsd(
    model: string,
    inputTokens: number,
    cachedTokens: number,
    outputTokens: number,
): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) {
        return 0;
    }
    const uncachedInput = inputTokens - cachedTokens;
    const cost =
        (uncachedInput * pricing.input) / 1_000_000 +
        (cachedTokens * pricing.cachedInput) / 1_000_000 +
        (outputTokens * pricing.output) / 1_000_000;
    return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}
