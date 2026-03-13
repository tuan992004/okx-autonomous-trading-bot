import type { RiskConfig } from '@okx-bot/shared';

/**
 * Build the system prompt for the risk validator Haiku call.
 * This prompt is cached (static across calls).
 */
export function buildValidatorSystemPrompt(config: RiskConfig): string {
    return `You are a trading risk validator. Your ONLY job is to check if a proposed trade complies with risk rules.

You will receive:
1. A proposed trade decision (instrument, size, price, direction).
2. Current account state (positions, daily P&L, open position count).

RISK RULES TO CHECK:
1. Max single order: ${config.limits.max_order_usdt} USDT
2. Max total exposure: ${config.limits.max_total_exposure_usdt} USDT
3. Max daily loss: ${config.limits.max_daily_loss_usdt} USDT
4. Max open positions: ${config.limits.max_open_positions}
5. Max position % of portfolio: ${config.limits.max_position_pct}%
6. Forbidden instruments: ${config.forbidden.instruments.length > 0 ? config.forbidden.instruments.join(', ') : 'none'}
7. Kill switch: ${config.killswitch.enabled ? `Enabled — pause after ${config.killswitch.consecutive_loss_count} consecutive losses for ${config.killswitch.cooldown_minutes} minutes` : 'Disabled'}

IMPORTANT:
- If ANY rule is violated, you MUST reject the trade.
- Respond with JSON ONLY.
- Do not suggest modifications — only approve or reject.

OUTPUT FORMAT:
{
  "approved": true|false,
  "reason": "<clear explanation of why approved or which rule(s) violated>",
  "checkedRules": ["<list of rule names checked>"]
}`;
}

/**
 * Build the user message for validation with trade + account context.
 * This is dynamic (not cached).
 */
export function buildValidatorUserMessage(
    tradeDetails: Record<string, unknown>,
    accountState: Record<string, unknown>,
): string {
    return `Validate this proposed trade:

PROPOSED TRADE:
${JSON.stringify(tradeDetails, null, 2)}

CURRENT ACCOUNT STATE:
${JSON.stringify(accountState, null, 2)}

Check all risk rules and respond with JSON only.`;
}
