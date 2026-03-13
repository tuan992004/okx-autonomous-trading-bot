import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateManager } from '../state-manager.js';
import type { Signal, TradeDecision, ApiUsageRecord } from '@okx-bot/shared';

describe('StateManager', () => {
    let state: StateManager;

    beforeEach(async () => {
        state = await StateManager.create(':memory:');
    });

    afterEach(() => {
        state.close();
    });

    // ─── Signals ──────────────────────────────────────────────────────────

    describe('signals', () => {
        const signal: Signal = {
            type: 'MOMENTUM',
            instrument: 'BTC-USDT',
            direction: 'LONG',
            confidence: 0.85,
            data: { priceChange: 2.5 },
            timestamp: new Date().toISOString(),
        };

        it('should record a signal and return an ID', () => {
            const id = state.recordSignal('cycle-1', signal);
            expect(id).toBeGreaterThan(0);
        });

        it('should record multiple signals with unique IDs', () => {
            const id1 = state.recordSignal('cycle-1', signal);
            const id2 = state.recordSignal('cycle-2', signal);
            expect(id2).toBeGreaterThan(id1);
        });
    });

    // ─── Decisions ────────────────────────────────────────────────────────

    describe('decisions', () => {
        it('should record a decision linked to a signal', () => {
            const signal: Signal = {
                type: 'RSI_OVERSOLD',
                instrument: 'ETH-USDT',
                direction: 'LONG',
                confidence: 0.7,
                data: { rsi: 25 },
                timestamp: new Date().toISOString(),
            };

            const signalId = state.recordSignal('cycle-1', signal);

            const decision: TradeDecision = {
                action: 'BUY',
                instrument: 'ETH-USDT',
                size: 50,
                price: 3000,
                stopLoss: 2900,
                takeProfit: 3200,
                orderType: 'limit',
                reasoning: 'RSI oversold, good entry point',
                model: 'claude-sonnet-4-6-20250514',
                toolCallCount: 3,
            };

            const decisionId = state.recordDecision('cycle-1', signalId, decision);
            expect(decisionId).toBeGreaterThan(0);
        });
    });

    // ─── Orders ───────────────────────────────────────────────────────────

    describe('orders', () => {
        it('should record an order and update fill result', () => {
            const orderId = state.recordOrder(
                'cycle-1', 1, 'BTC-USDT', 'buy', 100, 50000, 'pending', false,
            );
            expect(orderId).toBeGreaterThan(0);

            state.updateOrderResult(orderId, {
                orderId: 'okx-12345',
                instrument: 'BTC-USDT',
                status: 'filled',
                fillPrice: 50010,
                fillSize: 100,
                timestamp: new Date().toISOString(),
            });

            const recent = state.getRecentOrders('BTC-USDT', 10);
            expect(recent.length).toBe(1);
            expect(recent[0]!.status).toBe('filled');
            expect(recent[0]!.okx_order_id).toBe('okx-12345');
        });
    });

    // ─── Duplicate Order Detection ────────────────────────────────────────

    describe('checkDuplicateOrder', () => {
        it('should detect duplicate order within timeframe', () => {
            state.recordOrder('cycle-1', 1, 'BTC-USDT', 'buy', 100, 50000, 'filled', false);
            const isDuplicate = state.checkDuplicateOrder('BTC-USDT', 'buy', 5);
            expect(isDuplicate).toBe(true);
        });

        it('should not flag different instruments as duplicate', () => {
            state.recordOrder('cycle-1', 1, 'BTC-USDT', 'buy', 100, 50000, 'filled', false);
            const isDuplicate = state.checkDuplicateOrder('ETH-USDT', 'buy', 5);
            expect(isDuplicate).toBe(false);
        });

        it('should not flag different sides as duplicate', () => {
            state.recordOrder('cycle-1', 1, 'BTC-USDT', 'buy', 100, 50000, 'filled', false);
            const isDuplicate = state.checkDuplicateOrder('BTC-USDT', 'sell', 5);
            expect(isDuplicate).toBe(false);
        });

        it('should not flag rejected orders as duplicate', () => {
            state.recordOrder('cycle-1', 1, 'BTC-USDT', 'buy', 100, 50000, 'rejected', false, 'size too big');
            const isDuplicate = state.checkDuplicateOrder('BTC-USDT', 'buy', 5);
            expect(isDuplicate).toBe(false);
        });
    });

    // ─── Positions ────────────────────────────────────────────────────────

    describe('positions', () => {
        it('should sync and retrieve positions', () => {
            state.syncPositions([
                { instId: 'BTC-USDT', posSide: 'long', pos: 0.001, avgPx: 50000, upl: 10, lever: 1, mgnMode: 'cross', notionalUsd: 50 },
                { instId: 'ETH-USDT', posSide: 'long', pos: 0.1, avgPx: 3000, upl: 5, lever: 1, mgnMode: 'cross', notionalUsd: 300 },
            ]);

            const positions = state.getOpenPositions();
            expect(positions.length).toBe(2);
            expect(state.getOpenPositionCount()).toBe(2);
            expect(state.getTotalExposureUsd()).toBe(350);
        });

        it('should replace all positions on sync', () => {
            state.syncPositions([
                { instId: 'BTC-USDT', posSide: 'long', pos: 0.001, avgPx: 50000, upl: 0, lever: 1, mgnMode: 'cross', notionalUsd: 50 },
            ]);
            expect(state.getOpenPositionCount()).toBe(1);

            state.syncPositions([
                { instId: 'ETH-USDT', posSide: 'long', pos: 0.01, avgPx: 3000, upl: 0, lever: 1, mgnMode: 'cross', notionalUsd: 30 },
            ]);
            expect(state.getOpenPositionCount()).toBe(1);
            expect(state.getOpenPositions()[0]!.instrument).toBe('ETH-USDT');
        });
    });

    // ─── Daily Stats ──────────────────────────────────────────────────────

    describe('daily stats', () => {
        it('should create daily stats on first access', () => {
            const stats = state.getDailyStats();
            expect(stats).not.toBeNull();
            expect(stats!.total_pnl).toBe(0);
            expect(stats!.trade_count).toBe(0);
        });

        it('should track winning trades and reset consecutive losses', () => {
            state.updateDailyPnl(50);
            const stats = state.getDailyStats();
            expect(stats!.total_pnl).toBe(50);
            expect(stats!.win_count).toBe(1);
            expect(stats!.consecutive_losses).toBe(0);
        });

        it('should track losing trades and increment consecutive losses', () => {
            state.updateDailyPnl(-30);
            state.updateDailyPnl(-20);
            const stats = state.getDailyStats();
            expect(stats!.total_pnl).toBe(-50);
            expect(stats!.loss_count).toBe(2);
            expect(stats!.consecutive_losses).toBe(2);
        });

        it('should calculate daily loss correctly', () => {
            state.updateDailyPnl(-100);
            expect(state.getDailyLoss()).toBe(100);

            state.updateDailyPnl(50);
            expect(state.getDailyLoss()).toBe(50);
        });

        it('should report zero daily loss when profitable', () => {
            state.updateDailyPnl(100);
            expect(state.getDailyLoss()).toBe(0);
        });
    });

    // ─── Kill Switch ──────────────────────────────────────────────────────

    describe('trading lock / kill switch', () => {
        it('should lock trading when triggered', () => {
            expect(state.isTradingLocked()).toBe(false);
            state.lockTradingForDay();
            expect(state.isTradingLocked()).toBe(true);
        });

        it('should unlock after cooldown expires', () => {
            const pastTime = new Date(Date.now() - 10000).toISOString();
            state.lockTradingForDay(pastTime);
            expect(state.isTradingLocked()).toBe(false);
        });

        it('should remain locked when cooldown has not expired', () => {
            const futureTime = new Date(Date.now() + 3600000).toISOString();
            state.lockTradingForDay(futureTime);
            expect(state.isTradingLocked()).toBe(true);
        });
    });

    // ─── API Usage ────────────────────────────────────────────────────────

    describe('api usage', () => {
        it('should record API usage and accumulate daily cost', () => {
            const record: ApiUsageRecord = {
                cycleId: 'cycle-1',
                component: 'scanner',
                model: 'claude-haiku-4-5-20251001',
                inputTokens: 1500,
                cachedTokens: 1200,
                outputTokens: 200,
                costUsd: 0.001,
                timestamp: new Date().toISOString(),
            };

            state.recordApiUsage(record);
            state.recordApiUsage({ ...record, cycleId: 'cycle-2', costUsd: 0.002 });

            const cost = state.getDailyApiCost();
            expect(cost).toBeCloseTo(0.003, 6);
        });

        it('should return aggregate token usage', () => {
            const record: ApiUsageRecord = {
                cycleId: 'cycle-1',
                component: 'decision',
                model: 'claude-sonnet-4-6-20250514',
                inputTokens: 5000,
                cachedTokens: 2000,
                outputTokens: 1000,
                costUsd: 0.05,
                timestamp: new Date().toISOString(),
            };

            state.recordApiUsage(record);
            const totals = state.getTotalApiUsage();
            expect(totals.totalCost).toBeCloseTo(0.05, 6);
            expect(totals.totalInputTokens).toBe(5000);
            expect(totals.totalCachedTokens).toBe(2000);
        });
    });
});
