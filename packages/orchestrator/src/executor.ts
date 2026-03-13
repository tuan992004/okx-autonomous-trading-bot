import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@okx-bot/shared';
import type { TradeDecision, OrderResult } from '@okx-bot/shared';

const execFileAsync = promisify(execFile);
const logger = createLogger('orchestrator');

/**
 * Trade executor that handles both live and shadow mode execution.
 */
export class TradeExecutor {
    private isShadowMode: boolean;
    private profile: string;

    constructor(isShadowMode: boolean) {
        this.isShadowMode = isShadowMode;
        this.profile = process.env['OKX_PROFILE'] ?? 'demo';
    }

    /**
     * Execute a trade. In shadow mode, simulates the fill at mid-price.
     */
    async execute(decision: TradeDecision, cycleId: string): Promise<OrderResult> {
        if (decision.action === 'SKIP' || decision.action === 'CLOSE') {
            return {
                orderId: 'skip',
                instrument: decision.instrument,
                status: 'cancelled',
                fillPrice: null,
                fillSize: null,
                timestamp: new Date().toISOString(),
            };
        }

        if (this.isShadowMode) {
            return this.simulateExecution(decision, cycleId);
        }

        return this.liveExecution(decision, cycleId);
    }

    /**
     * Shadow mode: simulate a fill at the decision price.
     */
    private async simulateExecution(decision: TradeDecision, cycleId: string): Promise<OrderResult> {
        // Get current mid-price for simulation
        let midPrice = decision.price ?? 0;

        try {
            const { stdout } = await execFileAsync('okx', [
                '--profile', this.profile, '--json',
                'market', 'ticker', decision.instrument,
            ], { timeout: 10000 });

            const ticker = JSON.parse(stdout) as Record<string, string>;
            const bid = parseFloat(ticker['bidPx'] ?? '0');
            const ask = parseFloat(ticker['askPx'] ?? '0');
            if (bid > 0 && ask > 0) {
                midPrice = (bid + ask) / 2;
            }
        } catch {
            // Use decision price if can't fetch current price
        }

        const result: OrderResult = {
            orderId: `shadow-${cycleId}`,
            instrument: decision.instrument,
            status: 'simulated',
            fillPrice: midPrice,
            fillSize: decision.size,
            timestamp: new Date().toISOString(),
        };

        logger.info('🔮 SHADOW MODE: Simulated trade execution', {
            cycleId,
            data: {
                action: decision.action,
                instrument: decision.instrument,
                size: decision.size,
                simulatedFillPrice: midPrice,
            },
        });

        return result;
    }

    /**
     * Live mode: execute via okx-trade-cli.
     */
    private async liveExecution(decision: TradeDecision, cycleId: string): Promise<OrderResult> {
        const isSwap = decision.instrument.endsWith('-SWAP');
        const module = isSwap ? 'swap' : 'spot';

        const args = [
            '--profile', this.profile, '--json',
            module, 'place',
            '--instId', decision.instrument,
            '--side', decision.action === 'BUY' ? 'buy' : 'sell',
            '--ordType', decision.orderType,
            '--sz', String(decision.size),
        ];

        // Add price for limit orders
        if (decision.orderType !== 'market' && decision.price) {
            args.push('--px', String(decision.price));
        }

        // Add TP/SL if set
        if (decision.takeProfit) {
            args.push('--tpTriggerPx', String(decision.takeProfit));
            args.push('--tpOrdPx', String(decision.takeProfit));
        }
        if (decision.stopLoss) {
            args.push('--slTriggerPx', String(decision.stopLoss));
            args.push('--slOrdPx', String(decision.stopLoss));
        }

        // Swap-specific: add margin mode and position side
        if (isSwap) {
            args.push('--tdMode', 'cross');
            args.push('--posSide', decision.action === 'BUY' ? 'long' : 'short');
        }

        try {
            logger.info('Executing live trade', { cycleId, data: { args } });

            const { stdout } = await execFileAsync('okx', args, {
                timeout: 30000,
                maxBuffer: 1024 * 1024,
            });

            const response = JSON.parse(stdout) as Record<string, string>;
            const orderId = response['ordId'] ?? response['orderId'] ?? '';

            // Poll for fill status
            const fillResult = await this.pollOrderStatus(decision.instrument, orderId, module);

            return fillResult;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);

            // Handle specific OKX error codes
            if (msg.includes('51020')) {
                logger.error('OKX error: Invalid order size', { cycleId, data: { error: msg } });
            } else if (msg.includes('50011')) {
                logger.warn('OKX rate limit hit — backing off 60s', { cycleId });
                await this.sleep(60_000);
            }

            return {
                orderId: '',
                instrument: decision.instrument,
                status: 'rejected',
                fillPrice: null,
                fillSize: null,
                timestamp: new Date().toISOString(),
            };
        }
    }

    /**
     * Poll order status until filled or timeout.
     */
    private async pollOrderStatus(
        instId: string,
        orderId: string,
        module: string,
        maxAttempts: number = 10,
    ): Promise<OrderResult> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const { stdout } = await execFileAsync('okx', [
                    '--profile', this.profile, '--json',
                    module, 'get', '--instId', instId, '--ordId', orderId,
                ], { timeout: 10000 });

                const order = JSON.parse(stdout) as Record<string, string>;
                const state = String(order['state'] ?? '');

                if (state === 'filled') {
                    return {
                        orderId,
                        instrument: instId,
                        status: 'filled',
                        fillPrice: parseFloat(order['avgPx'] ?? '0'),
                        fillSize: parseFloat(order['accFillSz'] ?? '0'),
                        timestamp: new Date().toISOString(),
                    };
                }

                if (state === 'canceled' || state === 'cancelled') {
                    return {
                        orderId,
                        instrument: instId,
                        status: 'cancelled',
                        fillPrice: null,
                        fillSize: null,
                        timestamp: new Date().toISOString(),
                    };
                }

                // Partially filled
                if (state === 'partially_filled') {
                    const fillSz = parseFloat(order['accFillSz'] ?? '0');
                    if (fillSz > 0) {
                        return {
                            orderId,
                            instrument: instId,
                            status: 'partial',
                            fillPrice: parseFloat(order['avgPx'] ?? '0'),
                            fillSize: fillSz,
                            timestamp: new Date().toISOString(),
                        };
                    }
                }
            } catch {
                // Retry
            }

            await this.sleep(2000);
        }

        return {
            orderId,
            instrument: instId,
            status: 'pending',
            fillPrice: null,
            fillSize: null,
            timestamp: new Date().toISOString(),
        };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
