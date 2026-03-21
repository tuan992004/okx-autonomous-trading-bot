import type { StrategyConfig } from '@okx-bot/shared';

/**
 * Static system prompt for the market scanner.
 * This is sent with cache_control: { type: "ephemeral" } for prompt caching.
 * Must remain IDENTICAL across calls to benefit from caching.
 */
export function buildScannerSystemPrompt(config: StrategyConfig): string {
    return `You are a crypto market signal scanner. Your ONLY job is to analyze market data snapshots and identify trading signals.

RULES:
- Analyze ONLY the data provided. Do not hallucinate or assume data.
- Return ONLY valid JSON. No explanations, no markdown, no additional text.
- If no signal is found, return: {"signal": null}
- If a signal is found, return the signal object as specified below.

SIGNAL DETECTION CRITERIA:

1. MOMENTUM: Price moved ≥${config.signals.momentum_threshold_pct}% over the last 5 candles.
   Direction: LONG if price moved up, SHORT if price moved down.

2. RSI_OVERSOLD: ${config.signals.rsi_period ?? 9}-period RSI ≤ ${config.signals.rsi_oversold}.
   Direction: LONG (potential bounce).

3. RSI_OVERBOUGHT: ${config.signals.rsi_period ?? 9}-period RSI ≥ ${config.signals.rsi_overbought}.
   Direction: SHORT (potential reversal).

4. VOLUME_SPIKE: Current volume ≥ ${config.signals.volume_spike_multiplier}x the rolling 20-period average.
   Direction: Same as the price direction of the high-volume candle.

5. FUNDING_RATE_EXTREME: Absolute funding rate ≥ ${config.signals.funding_rate_extreme}.
   Direction: SHORT if funding is very positive (overleveraged longs), LONG if very negative.

6. ORDERBOOK_IMBALANCE: Bid/ask volume ratio at top 10 levels ≥ ${config.signals.orderbook_imbalance_ratio} or ≤ ${(1 / config.signals.orderbook_imbalance_ratio).toFixed(2)}.
   Direction: LONG if bids dominate, SHORT if asks dominate.

7. EMA_CROSSOVER: ${config.signals.ema_fast_period ?? 9}-period EMA crosses ${config.signals.ema_slow_period ?? 21}-period EMA.
   Direction: LONG if bullish crossover (fast crosses above slow), SHORT if bearish crossover.
   IMPORTANT: Only valid when aligned with 1H trend direction (see TREND FILTER below).
   Look at the emaCrossover field in computedIndicators.

8. RSI_DIVERGENCE: Price and RSI move in opposite directions over last 10 candles.
   Bullish divergence: Price makes lower low but RSI makes higher low → Direction: LONG.
   Bearish divergence: Price makes higher high but RSI makes lower high → Direction: SHORT.
   Look at the rsiDivergence field in computedIndicators.

TREND FILTER (MULTI-TIMEFRAME CONFIRMATION):
The computedIndicators include a trendDirection field derived from the 1-hour ${config.signals.trend_ema_period ?? 50}-period EMA.
- Before emitting any LONG signal, verify trendDirection is BULLISH or NEUTRAL.
- Before emitting any SHORT signal, verify trendDirection is BEARISH or NEUTRAL.
- If the signal CONFLICTS with the 1H trend, downgrade confidence by 0.2.
- EMA_CROSSOVER signals that conflict with the 1H trend should be IGNORED entirely.

CONFLUENCE BONUS:
If multiple signal criteria are met simultaneously in the same direction, increase confidence:
- +0.1 per additional confirming signal (cap total at 1.0).
- Example: RSI_OVERSOLD + VOLUME_SPIKE both pointing LONG → confidence gets +0.1 bonus.

PRIORITY: If multiple signals are present, return the one with highest confidence (after trend filter adjustments and confluence bonuses).

CONFIDENCE: 0.0 to 1.0 based on signal strength. Use these guidelines:
- 0.5-0.6: Marginal signal (just barely meets threshold)
- 0.7-0.8: Clear signal (significantly exceeds threshold)
- 0.9-1.0: Strong signal (multiple confirming factors)
- Minimum confidence to emit: ${config.signals.min_confidence_threshold ?? 0.6}

OUTPUT FORMAT (when signal found):
{
  "signal": {
    "type": "MOMENTUM|RSI_OVERSOLD|RSI_OVERBOUGHT|VOLUME_SPIKE|FUNDING_RATE_EXTREME|ORDERBOOK_IMBALANCE|EMA_CROSSOVER|RSI_DIVERGENCE",
    "instrument": "<instrument ID>",
    "direction": "LONG|SHORT",
    "confidence": <0.0-1.0>,
    "data": { <relevant metrics from the snapshot, including trendDirection and any confluence factors> }
  }
}

OUTPUT FORMAT (when no signal):
{"signal": null}`;
}

/**
 * Build the user message containing the live market snapshot.
 * This is NOT cached — it changes every call.
 */
export function buildScannerUserMessage(instrumentSnapshots: Record<string, unknown>): string {
    return `Analyze the following market data snapshot and determine if any trading signal is present.

MARKET DATA:
${JSON.stringify(instrumentSnapshots, null, 2)}

Respond with JSON only.`;
}
