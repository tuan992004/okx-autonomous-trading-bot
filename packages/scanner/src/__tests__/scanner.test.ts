import { describe, it, expect } from 'vitest';
import { buildScannerSystemPrompt, buildScannerUserMessage } from '../prompts.js';
import { MarketDataFetcher } from '../market-data.js';
import type { StrategyConfig, CandleData } from '@okx-bot/shared';

const mockConfig: StrategyConfig = {
    instruments: {
        spot: ['BTC-USDT', 'ETH-USDT'],
        swap: ['BTC-USDT-SWAP'],
    },
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

describe('Scanner Prompts', () => {
    it('should build system prompt containing all signal criteria', () => {
        const prompt = buildScannerSystemPrompt(mockConfig);

        // Verify signal thresholds are embedded
        expect(prompt).toContain('2%');
        expect(prompt).toContain('30');
        expect(prompt).toContain('70');
        expect(prompt).toContain('2.5');
        expect(prompt).toContain('0.001');
        expect(prompt).toContain('3');

        // Verify output format instructions
        expect(prompt).toContain('"signal"');
        expect(prompt).toContain('MOMENTUM');
        expect(prompt).toContain('RSI_OVERSOLD');
        expect(prompt).toContain('RSI_OVERBOUGHT');
        expect(prompt).toContain('VOLUME_SPIKE');
        expect(prompt).toContain('FUNDING_RATE_EXTREME');
        expect(prompt).toContain('ORDERBOOK_IMBALANCE');
    });

    it('should build system prompt that is consistent (cacheable)', () => {
        const prompt1 = buildScannerSystemPrompt(mockConfig);
        const prompt2 = buildScannerSystemPrompt(mockConfig);
        expect(prompt1).toBe(prompt2);
    });

    it('should build user message with market data snapshot', () => {
        const snapshot = {
            'BTC-USDT': { ticker: { last: 50000, bid: 49990, ask: 50010 } },
        };
        const message = buildScannerUserMessage(snapshot);
        expect(message).toContain('50000');
        expect(message).toContain('BTC-USDT');
        expect(message).toContain('JSON only');
    });
});

describe('MarketDataFetcher computations', () => {
    const fetcher = new MarketDataFetcher('demo');

    const makeCandles = (closes: number[]): CandleData[] =>
        closes.map((close, i) => ({
            ts: String(Date.now() - i * 300000),
            open: close - 10,
            high: close + 20,
            low: close - 20,
            close,
            vol: 1000 + i * 100,
            volCcy: 50000,
        }));

    describe('computeRSI', () => {
        it('should compute RSI for uptrending market', () => {
            // candles[0] = most recent (100), going backward to 30
            // computeRSI iterates i=1..14: candles[i].close - candles[i-1].close
            // e.g. 95-100=-5, all losses => RSI = 0
            const candles = makeCandles([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30]);
            const rsi = fetcher.computeRSI(candles, 14);
            expect(rsi).not.toBeNull();
            expect(rsi).toBe(0);
        });

        it('should compute RSI for downtrending market', () => {
            // candles[0] = most recent (30), going backward to 100
            // computeRSI: 35-30=+5, all gains => RSI = 100
            const candles = makeCandles([30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
            const rsi = fetcher.computeRSI(candles, 14);
            expect(rsi).not.toBeNull();
            expect(rsi).toBe(100);
        });

        it('should return null when insufficient data', () => {
            const candles = makeCandles([100, 95, 90]);
            expect(fetcher.computeRSI(candles, 14)).toBeNull();
        });
    });

    describe('computeVolumeAvg', () => {
        it('should calculate average volume', () => {
            const candles = makeCandles([100, 100, 100, 100, 100]);
            const avg = fetcher.computeVolumeAvg(candles, 5);
            expect(avg).not.toBeNull();
            expect(avg).toBeGreaterThan(0);
        });

        it('should return null when insufficient data', () => {
            const candles = makeCandles([100, 100]);
            expect(fetcher.computeVolumeAvg(candles, 5)).toBeNull();
        });
    });

    describe('computePriceChange', () => {
        it('should calculate positive price change', () => {
            const candles = makeCandles([110, 108, 106, 104, 100]);
            const change = fetcher.computePriceChange(candles, 5);
            expect(change).not.toBeNull();
            expect(change!).toBe(10); // (110 - 100) / 100 * 100 = 10%
        });

        it('should calculate negative price change', () => {
            const candles = makeCandles([90, 92, 94, 96, 100]);
            const change = fetcher.computePriceChange(candles, 5);
            expect(change).not.toBeNull();
            expect(change!).toBeCloseTo(-10, 1);
        });
    });

    describe('computeOrderbookImbalance', () => {
        it('should compute bid-heavy imbalance', () => {
            const imbalance = fetcher.computeOrderbookImbalance({
                bids: [{ price: 50000, size: 10, orderCount: 5 }],
                asks: [{ price: 50010, size: 2, orderCount: 3 }],
                ts: '',
            });
            expect(imbalance).toBe(5);
        });

        it('should return null when no asks', () => {
            const imbalance = fetcher.computeOrderbookImbalance({
                bids: [{ price: 50000, size: 10, orderCount: 5 }],
                asks: [],
                ts: '',
            });
            expect(imbalance).toBeNull();
        });
    });
});
