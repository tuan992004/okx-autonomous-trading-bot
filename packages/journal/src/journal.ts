import { createLogger } from '@okx-bot/shared';
import type { CycleContext, ApiUsageRecord } from '@okx-bot/shared';
import type { StateManager } from '@okx-bot/state';

const logger = createLogger('journal');

/**
 * Async trade journal that buffers cycle contexts and logs them.
 * Runs non-blocking after trade execution.
 */
export class TradeJournal {
    private state: StateManager;
    private buffer: CycleContext[] = [];
    private flushInterval: ReturnType<typeof setInterval> | null = null;

    constructor(state: StateManager) {
        this.state = state;
    }

    /**
     * Start periodic flushing of the journal buffer.
     */
    start(intervalMs: number = 60_000): void {
        this.flushInterval = setInterval(() => {
            this.flush().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error('Journal flush failed', { data: { error: msg } });
            });
        }, intervalMs);
        logger.info('Trade journal started', { data: { flushInterval: intervalMs } });
    }

    stop(): void {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = null;
        }
    }

    /**
     * Queue a trade cycle for journaling.
     */
    log(context: CycleContext): void {
        this.buffer.push(context);
        logger.info('Cycle queued for journaling', {
            cycleId: context.cycleId,
            data: {
                hasSignal: !!context.signal,
                hasDecision: !!context.decision,
                orderStatus: context.orderResult?.status,
            },
        });
    }

    /**
     * Flush all buffered entries to persistent storage.
     */
    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;

        const entries = [...this.buffer];
        this.buffer = [];

        logger.info(`Flushing ${entries.length} journal entries`);

        for (const entry of entries) {
            try {
                // Record order result P&L if we have fill data
                if (entry.orderResult && entry.orderResult.status === 'filled') {
                    // In a real implementation, P&L would be calculated from entry/exit prices
                    // For now, we log the fill as a trade event
                    logger.info('Trade fill recorded', {
                        cycleId: entry.cycleId,
                        data: {
                            orderId: entry.orderResult.orderId,
                            fillPrice: entry.orderResult.fillPrice,
                            fillSize: entry.orderResult.fillSize,
                        },
                    });
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error('Failed to journal entry', {
                    cycleId: entry.cycleId,
                    data: { error: msg },
                });
            }
        }
    }

    /**
     * Get a summary of today's trading activity.
     */
    getDailySummary(): Record<string, unknown> {
        const stats = this.state.getDailyStats();
        const apiUsage = this.state.getTotalApiUsage();

        return {
            date: stats?.date,
            totalPnl: stats?.total_pnl ?? 0,
            winCount: stats?.win_count ?? 0,
            lossCount: stats?.loss_count ?? 0,
            tradeCount: stats?.trade_count ?? 0,
            winRate: stats && stats.trade_count > 0
                ? ((stats.win_count / stats.trade_count) * 100).toFixed(1) + '%'
                : 'N/A',
            apiCostUsd: stats?.api_cost_usd ?? 0,
            totalTokens: apiUsage.totalInputTokens + apiUsage.totalOutputTokens,
            cachedTokenRatio: apiUsage.totalInputTokens > 0
                ? ((apiUsage.totalCachedTokens / apiUsage.totalInputTokens) * 100).toFixed(1) + '%'
                : 'N/A',
            isLocked: stats?.is_locked === 1,
        };
    }
}

export default TradeJournal;
