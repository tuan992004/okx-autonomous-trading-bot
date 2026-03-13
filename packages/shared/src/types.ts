import { z } from 'zod';

// ─── Signal Types ─────────────────────────────────────────────────────────────

export const SignalTypeSchema = z.enum([
    'MOMENTUM',
    'RSI_OVERSOLD',
    'RSI_OVERBOUGHT',
    'VOLUME_SPIKE',
    'FUNDING_RATE_EXTREME',
    'ORDERBOOK_IMBALANCE',
]);
export type SignalType = z.infer<typeof SignalTypeSchema>;

export const SignalSchema = z.object({
    type: SignalTypeSchema,
    instrument: z.string(),
    direction: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
    confidence: z.number().min(0).max(1),
    data: z.record(z.unknown()),
    timestamp: z.string().datetime(),
});
export type Signal = z.infer<typeof SignalSchema>;

// ─── Trade Decision ───────────────────────────────────────────────────────────

export const TradeActionSchema = z.enum(['BUY', 'SELL', 'CLOSE', 'SKIP']);
export type TradeAction = z.infer<typeof TradeActionSchema>;

export const TradeDecisionSchema = z.object({
    action: TradeActionSchema,
    instrument: z.string(),
    size: z.number().min(0),
    price: z.number().positive().optional(),
    stopLoss: z.number().positive().optional(),
    takeProfit: z.number().positive().optional(),
    orderType: z.enum(['market', 'limit', 'post_only', 'fok', 'ioc']).default('limit'),
    reasoning: z.string(),
    model: z.string(),
    thinkingContent: z.string().optional(),
    toolCallCount: z.number().int().min(0),
});
export type TradeDecision = z.infer<typeof TradeDecisionSchema>;

// ─── Validation Result ────────────────────────────────────────────────────────

export const ValidationResultSchema = z.object({
    approved: z.boolean(),
    reason: z.string(),
    checkedRules: z.array(z.string()).optional(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ─── Configuration Types ──────────────────────────────────────────────────────

export const StrategyConfigSchema = z.object({
    instruments: z.object({
        spot: z.array(z.string()),
        swap: z.array(z.string()),
    }),
    signals: z.object({
        momentum_threshold_pct: z.number().positive(),
        rsi_oversold: z.number().int().min(0).max(100),
        rsi_overbought: z.number().int().min(0).max(100),
        volume_spike_multiplier: z.number().positive(),
        funding_rate_extreme: z.number().positive(),
        orderbook_imbalance_ratio: z.number().positive(),
    }),
    execution: z.object({
        default_order_type: z.enum(['market', 'limit', 'post_only']),
        limit_offset_bps: z.number().min(0),
        max_slippage_bps: z.number().min(0),
        scan_interval_seconds: z.number().int().positive(),
    }),
    models: z.object({
        scanner: z.string(),
        decision: z.string(),
        validator: z.string(),
        use_opus_for_complex: z.boolean(),
    }),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export const RiskConfigSchema = z.object({
    limits: z.object({
        max_order_usdt: z.number().positive(),
        max_total_exposure_usdt: z.number().positive(),
        max_daily_loss_usdt: z.number().positive(),
        max_open_positions: z.number().int().positive(),
        max_position_pct: z.number().min(0).max(100),
    }),
    killswitch: z.object({
        enabled: z.boolean(),
        consecutive_loss_count: z.number().int().positive(),
        cooldown_minutes: z.number().int().positive(),
    }),
    forbidden: z.object({
        instruments: z.array(z.string()),
    }),
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

// ─── Cycle Context ────────────────────────────────────────────────────────────

export interface CycleContext {
    cycleId: string;
    startedAt: string;
    signal: Signal | null;
    decision: TradeDecision | null;
    validation: ValidationResult | null;
    orderResult: OrderResult | null;
}

export interface OrderResult {
    orderId: string;
    instrument: string;
    status: 'filled' | 'partial' | 'pending' | 'cancelled' | 'rejected' | 'simulated';
    fillPrice: number | null;
    fillSize: number | null;
    timestamp: string;
}

// ─── API Usage ────────────────────────────────────────────────────────────────

export interface ApiUsageRecord {
    cycleId: string;
    component: ComponentName;
    model: string;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    costUsd: number;
    timestamp: string;
}

// ─── Market Data ──────────────────────────────────────────────────────────────

export interface TickerData {
    instId: string;
    last: number;
    lastSz: number;
    askPx: number;
    askSz: number;
    bidPx: number;
    bidSz: number;
    open24h: number;
    high24h: number;
    low24h: number;
    vol24h: number;
    volCcy24h: number;
    ts: string;
}

export interface CandleData {
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    vol: number;
    volCcy: number;
}

export interface OrderbookLevel {
    price: number;
    size: number;
    orderCount: number;
}

export interface OrderbookData {
    asks: OrderbookLevel[];
    bids: OrderbookLevel[];
    ts: string;
}

export interface FundingRateData {
    instId: string;
    fundingRate: number;
    nextFundingRate: number;
    fundingTime: string;
}

export interface MarketSnapshot {
    instrument: string;
    ticker: TickerData;
    candles: CandleData[];
    orderbook: OrderbookData;
    fundingRate: FundingRateData | null;
    computedIndicators: {
        rsi14: number | null;
        volumeRollingAvg: number | null;
        priceChange5: number | null;
        orderbookImbalance: number | null;
    };
}

// ─── Position ─────────────────────────────────────────────────────────────────

export interface PositionData {
    instId: string;
    posSide: 'long' | 'short' | 'net';
    pos: number;
    avgPx: number;
    upl: number;
    lever: number;
    mgnMode: 'cross' | 'isolated';
    notionalUsd: number;
}

// ─── Utility Types ────────────────────────────────────────────────────────────

export type ComponentName = 'scanner' | 'decision' | 'validator' | 'orchestrator' | 'journal';

export interface LogMeta {
    component: ComponentName;
    cycleId?: string;
    model?: string;
    tokensUsed?: number;
    cachedTokens?: number;
    estimatedCostUSD?: number;
    data?: Record<string, unknown>;
}
