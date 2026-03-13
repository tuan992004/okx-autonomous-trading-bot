import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RiskValidator } from '../validator.js';
import { StateManager } from '@okx-bot/state';
import type { TradeDecision, RiskConfig, StrategyConfig } from '@okx-bot/shared';

// Mock the Anthropic client
vi.mock('@okx-bot/shared', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getAnthropicClient: () => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"approved": true, "reason": "All rules passed", "checkedRules": []}' }],
          model: 'claude-haiku-4-5-20251001',
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    }),
  };
});

const riskConfig: RiskConfig = {
  limits: {
    max_order_usdt: 1000,
    max_total_exposure_usdt: 5000,
    max_daily_loss_usdt: 200,
    max_open_positions: 3,
    max_position_pct: 40,
  },
  killswitch: {
    enabled: true,
    consecutive_loss_count: 5,
    cooldown_minutes: 60,
  },
  forbidden: {
    instruments: ['SHIB-USDT'],
  },
};

const strategyConfig: StrategyConfig = {
  instruments: { spot: ['BTC-USDT'], swap: [] },
  signals: {
    momentum_threshold_pct: 2.0,
    rsi_oversold: 30,
    rsi_overbought: 70,
    volume_spike_multiplier: 2.5,
    funding_rate_extreme: 0.001,
    orderbook_imbalance_ratio: 3.0,
  },
  execution: {
    default_order_type: 'limit',
    limit_offset_bps: 5,
    max_slippage_bps: 20,
    scan_interval_seconds: 30,
  },
  models: {
    scanner: 'claude-haiku-4-5-20251001',
    decision: 'claude-sonnet-4-6-20250514',
    validator: 'claude-haiku-4-5-20251001',
    use_opus_for_complex: false,
  },
};

function makeDecision(overrides: Partial<TradeDecision> = {}): TradeDecision {
  return {
    action: 'BUY',
    instrument: 'BTC-USDT',
    size: 100,
    price: 5,
    orderType: 'limit',
    reasoning: 'Test trade',
    model: 'claude-sonnet-4-6-20250514',
    toolCallCount: 1,
    ...overrides,
  };
}

describe('RiskValidator — Code-Level Checks', () => {
  let state: StateManager;
  let validator: RiskValidator;

  beforeEach(async () => {
    state = await StateManager.create(':memory:');
    validator = new RiskValidator(riskConfig, strategyConfig, state);
  });

  afterEach(() => {
    state.close();
  });

  // ─── SKIP Action ──────────────────────────────────────────────────

  it('should always APPROVE SKIP actions', async () => {
    const decision = makeDecision({ action: 'SKIP', size: 0 });
    const { validation } = await validator.validate(decision, 'cycle-skip');
    expect(validation.approved).toBe(true);
  });

  // ─── Max Order Size ────────────────────────────────────────────────

  it('should REJECT orders exceeding max single order USDT limit', async () => {
    const decision = makeDecision({ size: 200, price: 10 }); // 200 * 10 = 2000 USDT
    const { validation } = await validator.validate(decision, 'cycle-1');
    expect(validation.approved).toBe(false);
    expect(validation.reason).toContain('absolute limit');
  });

  it('should APPROVE orders within max single order limit', async () => {
    const decision = makeDecision({ size: 50, price: 10 }); // 50 * 10 = 500 USDT
    const { validation } = await validator.validate(decision, 'cycle-2');
    expect(validation.approved).toBe(true);
  });

  // ─── Instrument Type ──────────────────────────────────────────────

  it('should REJECT forbidden instruments', async () => {
    const decision = makeDecision({ instrument: 'SHIB-USDT', size: 10, price: 1 });
    const { validation } = await validator.validate(decision, 'cycle-3');
    expect(validation.approved).toBe(false);
    expect(validation.reason).toContain('forbidden');
  });

  it('should APPROVE allowed instrument types', async () => {
    const decision = makeDecision({ instrument: 'BTC-USDT-SWAP', size: 50, price: 10 });
    const { validation } = await validator.validate(decision, 'cycle-4');
    expect(validation.approved).toBe(true);
  });

  // ─── Total Exposure ───────────────────────────────────────────────

  it('should REJECT when total exposure would exceed limit', async () => {
    state.syncPositions([
      { instId: 'BTC-USDT', posSide: 'long', pos: 0.1, avgPx: 50000, upl: 0, lever: 1, mgnMode: 'cross', notionalUsd: 4800 },
    ]);

    const decision = makeDecision({ size: 50, price: 10 }); // +500 USDT, total 5300 > 5000
    const { validation } = await validator.validate(decision, 'cycle-5');
    expect(validation.approved).toBe(false);
    expect(validation.reason).toContain('exposure');
  });

  // ─── Daily Loss ───────────────────────────────────────────────────

  it('should REJECT when daily loss limit is reached', async () => {
    state.updateDailyPnl(-200); // Exactly at limit
    const decision = makeDecision({ size: 10, price: 5 });
    const { validation } = await validator.validate(decision, 'cycle-6');
    expect(validation.approved).toBe(false);
    expect(validation.reason).toContain('Daily loss');
  });

  it('should APPROVE when daily loss is below limit', async () => {
    state.updateDailyPnl(-100); // Below limit
    const decision = makeDecision({ size: 10, price: 5 });
    const { validation } = await validator.validate(decision, 'cycle-7');
    expect(validation.approved).toBe(true);
  });

  // ─── Trading Lock ─────────────────────────────────────────────────

  it('should REJECT when trading is locked', async () => {
    const futureTime = new Date(Date.now() + 3600000).toISOString();
    state.lockTradingForDay(futureTime);
    const decision = makeDecision({ size: 10, price: 5 });
    const { validation } = await validator.validate(decision, 'cycle-8');
    expect(validation.approved).toBe(false);
    expect(validation.reason).toContain('locked');
  });

  // ─── Duplicate Orders ─────────────────────────────────────────────

  it('should REJECT duplicate orders within 5 minutes', async () => {
    state.recordOrder('cycle-9', 1, 'BTC-USDT', 'buy', 100, 50000, 'filled', false);
    const decision = makeDecision({ size: 10, price: 5 });
    const { validation } = await validator.validate(decision, 'cycle-10');
    expect(validation.approved).toBe(false);
    expect(validation.reason).toContain('Duplicate');
  });

  // ─── Max Open Positions ───────────────────────────────────────────

  it('should REJECT when max open positions reached', async () => {
    state.syncPositions([
      { instId: 'BTC-USDT', posSide: 'long', pos: 0.01, avgPx: 50000, upl: 0, lever: 1, mgnMode: 'cross', notionalUsd: 500 },
      { instId: 'ETH-USDT', posSide: 'long', pos: 0.1, avgPx: 3000, upl: 0, lever: 1, mgnMode: 'cross', notionalUsd: 300 },
      { instId: 'SOL-USDT', posSide: 'long', pos: 1, avgPx: 100, upl: 0, lever: 1, mgnMode: 'cross', notionalUsd: 100 },
    ]);
    const decision = makeDecision({ instrument: 'DOGE-USDT', size: 10, price: 0.5 });
    const { validation } = await validator.validate(decision, 'cycle-11');
    expect(validation.approved).toBe(false);
    expect(validation.reason).toContain('positions');
  });

  // ─── Consecutive Loss Kill Switch ─────────────────────────────────

  it('should REJECT and lock when consecutive loss count reached', async () => {
    for (let i = 0; i < 5; i++) {
      state.updateDailyPnl(-10);
    }
    const decision = makeDecision({ size: 10, price: 5 });
    const { validation } = await validator.validate(decision, 'cycle-12');
    expect(validation.approved).toBe(false);
    expect(validation.reason).toContain('Kill switch');
    expect(state.isTradingLocked()).toBe(true);
  });
});
