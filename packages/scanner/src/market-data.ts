import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@okx-bot/shared';
import type { TickerData, CandleData, OrderbookData, OrderbookLevel, FundingRateData, MarketSnapshot } from '@okx-bot/shared';

const execFileAsync = promisify(execFile);
const logger = createLogger('scanner');

/**
 * Fetches market data from OKX using the okx-trade-cli command.
 * Falls back to the OKX REST API if the CLI is not available.
 */
export class MarketDataFetcher {
    private profile: string;

    constructor(profile?: string) {
        this.profile = profile ?? process.env['OKX_PROFILE'] ?? 'demo';
    }

    /**
     * Execute an okx-trade-cli command and parse JSON output.
     */
    private async execCli(args: string[]): Promise<unknown> {
        try {
            const fullArgs = ['--profile', this.profile, '--json', ...args];
            const { stdout } = await execFileAsync('okx', fullArgs, {
                timeout: 15000,
                maxBuffer: 1024 * 1024,
            });
            return JSON.parse(stdout);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('CLI command failed', { args, error: msg });
            throw new Error(`OKX CLI failed: ${msg}`);
        }
    }

    async getTicker(instId: string): Promise<TickerData> {
        const data = await this.execCli(['market', 'ticker', instId]) as Record<string, unknown>;
        return this.parseTickerData(data);
    }

    async getCandles(instId: string, bar: string = '5m', limit: number = 20): Promise<CandleData[]> {
        const data = await this.execCli([
            'market', 'candles', instId, '--bar', bar, '--limit', String(limit),
        ]) as unknown[];
        return (data ?? []).map((c) => this.parseCandleData(c as Record<string, string>));
    }

    async getOrderbook(instId: string, depth: number = 10): Promise<OrderbookData> {
        const data = await this.execCli([
            'market', 'orderbook', instId, '--sz', String(depth),
        ]) as Record<string, unknown>;
        return this.parseOrderbookData(data);
    }

    async getFundingRate(instId: string): Promise<FundingRateData | null> {
        if (!instId.endsWith('-SWAP')) return null;
        try {
            const data = await this.execCli([
                'market', 'funding-rate', instId,
            ]) as Record<string, string>;
            return {
                instId,
                fundingRate: parseFloat(data['fundingRate'] ?? '0'),
                nextFundingRate: parseFloat(data['nextFundingRate'] ?? '0'),
                fundingTime: String(data['fundingTime'] ?? ''),
            };
        } catch {
            return null;
        }
    }

    /**
     * Fetch a full market snapshot for a single instrument.
     * Includes multi-timeframe data: 5m candles for signals, 1H candles for trend.
     */
    async getSnapshot(instId: string, config?: {
        emaFastPeriod?: number;
        emaSlowPeriod?: number;
        trendEmaPeriod?: number;
        rsiPeriod?: number;
    }): Promise<MarketSnapshot> {
        const emaFastPeriod = config?.emaFastPeriod ?? 9;
        const emaSlowPeriod = config?.emaSlowPeriod ?? 21;
        const trendEmaPeriod = config?.trendEmaPeriod ?? 50;
        const rsiPeriod = config?.rsiPeriod ?? 9;

        const [ticker, candles, trendCandles, orderbook, fundingRate] = await Promise.all([
            this.getTicker(instId),
            this.getCandles(instId, '5m', 30),   // 30 bars for EMA(21) + padding
            this.getCandles(instId, '1H', 60),    // 60 bars for trend EMA(50)
            this.getOrderbook(instId, 10),
            this.getFundingRate(instId),
        ]);

        // EMA crossover from 5m candles
        const emaFast = this.computeEMA(candles, emaFastPeriod);
        const emaSlow = this.computeEMA(candles, emaSlowPeriod);
        const crossover = this.computeEMACrossover(candles, emaFastPeriod, emaSlowPeriod);

        // Trend EMA from 1H candles
        const trendEma = this.computeEMA(trendCandles, trendEmaPeriod);
        let trendDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
        if (trendEma !== null && trendCandles.length > 0) {
            const currentPrice = trendCandles[0]!.close;
            const pctAbove = ((currentPrice - trendEma) / trendEma) * 100;
            if (pctAbove > 0.5) trendDirection = 'BULLISH';
            else if (pctAbove < -0.5) trendDirection = 'BEARISH';
        }

        const computedIndicators = {
            rsi14: this.computeRSI(candles, rsiPeriod),
            volumeRollingAvg: this.computeVolumeAvg(candles, 20),
            priceChange5: this.computePriceChange(candles, 5),
            orderbookImbalance: this.computeOrderbookImbalance(orderbook),
            emaFast,
            emaSlow,
            emaCrossover: crossover,
            trendEma,
            trendDirection,
            rsiDivergence: this.computeRSIDivergence(candles, rsiPeriod),
        };

        return {
            instrument: instId,
            ticker,
            candles,
            orderbook,
            fundingRate,
            computedIndicators,
        };
    }

    // ─── Indicator Calculations ───────────────────────────────────────────

    computeRSI(candles: CandleData[], period: number): number | null {
        if (candles.length < period + 1) return null;

        let gains = 0;
        let losses = 0;

        for (let i = 1; i <= period; i++) {
            const change = candles[i]!.close - candles[i - 1]!.close;
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - 100 / (1 + rs);
    }

    computeVolumeAvg(candles: CandleData[], period: number): number | null {
        if (candles.length < period) return null;
        const total = candles.slice(0, period).reduce((sum, c) => sum + c.vol, 0);
        return total / period;
    }

    computePriceChange(candles: CandleData[], periods: number): number | null {
        if (candles.length < periods) return null;
        const recent = candles[0]!.close;
        const past = candles[periods - 1]!.close;
        if (past === 0) return null;
        return ((recent - past) / past) * 100;
    }

    computeOrderbookImbalance(orderbook: OrderbookData): number | null {
        const totalBids = orderbook.bids.reduce((sum, b) => sum + b.size, 0);
        const totalAsks = orderbook.asks.reduce((sum, a) => sum + a.size, 0);
        if (totalAsks === 0) return null;
        return totalBids / totalAsks;
    }

    /**
     * Compute Exponential Moving Average for a given period.
     * Returns the most recent EMA value, or null if insufficient data.
     */
    computeEMA(candles: CandleData[], period: number): number | null {
        if (candles.length < period) return null;

        // Candles are newest-first; reverse for chronological computation
        const closes = candles.map(c => c.close).reverse();
        const multiplier = 2 / (period + 1);

        // Seed with SMA of first `period` values
        let ema = 0;
        for (let i = 0; i < period; i++) {
            ema += closes[i]!;
        }
        ema /= period;

        // Compute EMA from period onward
        for (let i = period; i < closes.length; i++) {
            ema = (closes[i]! - ema) * multiplier + ema;
        }

        return ema;
    }

    /**
     * Detect EMA crossover between fast and slow EMA.
     * Checks if a crossover happened in the last 2 candles.
     */
    computeEMACrossover(
        candles: CandleData[],
        fastPeriod: number,
        slowPeriod: number,
    ): 'bullish' | 'bearish' | 'none' {
        // Need at least slowPeriod + 1 candles to compare previous vs current
        if (candles.length < slowPeriod + 1) return 'none';

        // Current EMAs (all candles)
        const fastNow = this.computeEMA(candles, fastPeriod);
        const slowNow = this.computeEMA(candles, slowPeriod);

        // Previous EMAs (skip most recent candle)
        const prevCandles = candles.slice(1);
        const fastPrev = this.computeEMA(prevCandles, fastPeriod);
        const slowPrev = this.computeEMA(prevCandles, slowPeriod);

        if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
            return 'none';
        }

        // Bullish crossover: fast was below slow, now fast is above slow
        if (fastPrev <= slowPrev && fastNow > slowNow) return 'bullish';
        // Bearish crossover: fast was above slow, now fast is below slow
        if (fastPrev >= slowPrev && fastNow < slowNow) return 'bearish';

        return 'none';
    }

    /**
     * Detect RSI divergence over the last 10 candles.
     * Bullish divergence: price makes lower low but RSI makes higher low.
     * Bearish divergence: price makes higher high but RSI makes lower high.
     */
    computeRSIDivergence(
        candles: CandleData[],
        rsiPeriod: number,
    ): 'bullish' | 'bearish' | 'none' {
        const windowSize = 10;
        if (candles.length < rsiPeriod + windowSize) return 'none';

        // Compute RSI for recent candle slices (newest first)
        const rsiValues: (number | null)[] = [];
        for (let i = 0; i < windowSize; i++) {
            rsiValues.push(this.computeRSI(candles.slice(i), rsiPeriod));
        }

        // Find lows and highs in the window
        const recentClose = candles[0]!.close;
        const recentRsi = rsiValues[0] ?? null;
        if (recentRsi === null) return 'none';

        // Check for bullish divergence (look at lows)
        for (let i = 3; i < windowSize; i++) {
            const pastClose = candles[i]!.close;
            const pastRsi = rsiValues[i] ?? null;
            if (pastRsi === null) continue;

            // Price made a lower low, but RSI made a higher low
            if (recentClose < pastClose && recentRsi > pastRsi) {
                return 'bullish';
            }
        }

        // Check for bearish divergence (look at highs)
        for (let i = 3; i < windowSize; i++) {
            const pastClose = candles[i]!.close;
            const pastRsi = rsiValues[i] ?? null;
            if (pastRsi === null) continue;

            // Price made a higher high, but RSI made a lower high
            if (recentClose > pastClose && recentRsi < pastRsi) {
                return 'bearish';
            }
        }

        return 'none';
    }

    // ─── Parsers ──────────────────────────────────────────────────────────

    private parseTickerData(raw: Record<string, unknown>): TickerData {
        return {
            instId: String(raw['instId'] ?? ''),
            last: parseFloat(String(raw['last'] ?? '0')),
            lastSz: parseFloat(String(raw['lastSz'] ?? '0')),
            askPx: parseFloat(String(raw['askPx'] ?? '0')),
            askSz: parseFloat(String(raw['askSz'] ?? '0')),
            bidPx: parseFloat(String(raw['bidPx'] ?? '0')),
            bidSz: parseFloat(String(raw['bidSz'] ?? '0')),
            open24h: parseFloat(String(raw['open24h'] ?? '0')),
            high24h: parseFloat(String(raw['high24h'] ?? '0')),
            low24h: parseFloat(String(raw['low24h'] ?? '0')),
            vol24h: parseFloat(String(raw['vol24h'] ?? '0')),
            volCcy24h: parseFloat(String(raw['volCcy24h'] ?? '0')),
            ts: String(raw['ts'] ?? ''),
        };
    }

    private parseCandleData(raw: Record<string, string>): CandleData {
        return {
            ts: String(raw['ts'] ?? raw[0] ?? ''),
            open: parseFloat(String(raw['o'] ?? raw[1] ?? '0')),
            high: parseFloat(String(raw['h'] ?? raw[2] ?? '0')),
            low: parseFloat(String(raw['l'] ?? raw[3] ?? '0')),
            close: parseFloat(String(raw['c'] ?? raw[4] ?? '0')),
            vol: parseFloat(String(raw['vol'] ?? raw[5] ?? '0')),
            volCcy: parseFloat(String(raw['volCcy'] ?? raw[6] ?? '0')),
        };
    }

    private parseOrderbookData(raw: Record<string, unknown>): OrderbookData {
        const bids = (raw['bids'] as Array<unknown[]> ?? []).map(this.parseLevel);
        const asks = (raw['asks'] as Array<unknown[]> ?? []).map(this.parseLevel);
        return { bids, asks, ts: String(raw['ts'] ?? '') };
    }

    private parseLevel(level: unknown[]): OrderbookLevel {
        return {
            price: parseFloat(String(level[0] ?? '0')),
            size: parseFloat(String(level[1] ?? '0')),
            orderCount: parseInt(String(level[2] ?? '0'), 10),
        };
    }
}
