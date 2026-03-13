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
     */
    async getSnapshot(instId: string): Promise<MarketSnapshot> {
        const [ticker, candles, orderbook, fundingRate] = await Promise.all([
            this.getTicker(instId),
            this.getCandles(instId, '5m', 20),
            this.getOrderbook(instId, 10),
            this.getFundingRate(instId),
        ]);

        const computedIndicators = {
            rsi14: this.computeRSI(candles, 14),
            volumeRollingAvg: this.computeVolumeAvg(candles, 20),
            priceChange5: this.computePriceChange(candles, 5),
            orderbookImbalance: this.computeOrderbookImbalance(orderbook),
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
