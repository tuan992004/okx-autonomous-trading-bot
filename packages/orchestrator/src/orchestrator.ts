import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    createLogger,
    logWithMeta,
    loadStrategyConfig,
    loadRiskConfig,
    ABSOLUTE_LIMITS,
} from '@okx-bot/shared';
import type {
    StrategyConfig,
    RiskConfig,
    CycleContext,
    PositionData,
} from '@okx-bot/shared';
import { StateManager } from '@okx-bot/state';
import { MarketScanner } from '@okx-bot/scanner';
import { StrategyDecisionMaker } from '@okx-bot/decision';
import { RiskValidator } from '@okx-bot/validator';
import { TradeJournal } from '@okx-bot/journal';
import { TradeExecutor } from './executor.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('orchestrator');

/**
 * Main orchestrator — ties all packages together in a 30s main loop.
 */
export class Orchestrator {
    private strategyConfig: StrategyConfig;
    private riskConfig: RiskConfig;
    private state: StateManager;
    private scanner: MarketScanner;
    private decisionMaker: StrategyDecisionMaker;
    private validator: RiskValidator;
    private journal: TradeJournal;
    private executor: TradeExecutor;
    private isShadowMode: boolean;
    private running: boolean = false;
    private loopTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor(
        strategyConfig: StrategyConfig,
        riskConfig: RiskConfig,
        state: StateManager,
        isShadowMode: boolean,
    ) {
        this.strategyConfig = strategyConfig;
        this.riskConfig = riskConfig;
        this.state = state;
        this.isShadowMode = isShadowMode;
        this.scanner = new MarketScanner(strategyConfig);
        this.decisionMaker = new StrategyDecisionMaker(strategyConfig);
        this.validator = new RiskValidator(riskConfig, strategyConfig, state);
        this.journal = new TradeJournal(state);
        this.executor = new TradeExecutor(isShadowMode);
    }

    static async create(): Promise<Orchestrator> {
        // Determine trading mode
        const isShadowMode = process.env['LIVE_TRADING'] !== 'true';

        if (isShadowMode) {
            logger.info('🔮 SHADOW MODE ACTIVE — No real trades will be placed');
        } else {
            logger.warn('⚡ LIVE TRADING MODE — Real orders will be executed!');
        }

        // Load configs
        const strategyConfig = loadStrategyConfig();
        const riskConfig = loadRiskConfig();
        logger.info('Configuration loaded', {
            data: {
                instruments: [
                    ...strategyConfig.instruments.spot,
                    ...strategyConfig.instruments.swap,
                ],
                shadowMode: isShadowMode,
            },
        });

        // Initialize state (async)
        const state = await StateManager.create();

        return new Orchestrator(strategyConfig, riskConfig, state, isShadowMode);
    }

    /**
     * Startup sequence.
     */
    async start(): Promise<void> {
        logger.info('═══════════════════════════════════════════════');
        logger.info('  OKX Autonomous Trading Bot — Starting Up');
        logger.info('═══════════════════════════════════════════════');

        // Step 1: Check OKX API connectivity
        await this.checkConnectivity();

        // Step 2: Sync current positions
        await this.syncPositions();

        // Step 3: Check if daily loss limit already hit
        const dailyLoss = this.state.getDailyLoss();
        if (dailyLoss >= ABSOLUTE_LIMITS.maxDailyLossUSDT) {
            logger.error(`Daily loss limit already reached: ${dailyLoss.toFixed(2)} USDT. Aborting.`);
            this.state.lockTradingForDay();
            return;
        }

        // Step 4: Check if trading is locked
        if (this.state.isTradingLocked()) {
            logger.warn('Trading is currently locked (kill switch). Will monitor but not trade.');
        }

        // Step 5: Start journal
        this.journal.start();

        // Step 6: Start main loop
        this.running = true;
        logger.info(`Main loop starting — scan interval: ${this.strategyConfig.execution.scan_interval_seconds}s`);
        await this.runLoop();
    }

    /**
     * Graceful shutdown.
     */
    async shutdown(reason: string = 'manual'): Promise<void> {
        logger.info(`Shutting down — reason: ${reason}`);
        this.running = false;

        if (this.loopTimer) {
            clearTimeout(this.loopTimer);
            this.loopTimer = null;
        }

        // Stop journal
        this.journal.stop();
        await this.journal.flush();

        // Log daily summary
        const summary = this.journal.getDailySummary();
        logger.info('═══════════════════════════════════════════════');
        logger.info('  Daily Trading Summary');
        logger.info('═══════════════════════════════════════════════');
        logger.info('Summary', { data: summary });

        // Clean up
        this.state.close();
        logger.info('Shutdown complete');
    }

    /**
     * Main event loop — runs every scan_interval_seconds.
     */
    private async runLoop(): Promise<void> {
        while (this.running) {
            const cycleId = randomUUID();
            const context: CycleContext = {
                cycleId,
                startedAt: new Date().toISOString(),
                signal: null,
                decision: null,
                validation: null,
                orderResult: null,
            };

            try {
                await this.runCycle(cycleId, context);
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error('Cycle failed with unhandled error', {
                    cycleId,
                    data: { error: msg },
                });
            }

            // Journal this cycle (async)
            this.journal.log(context);

            // Wait for next cycle
            if (this.running) {
                await this.sleep(this.strategyConfig.execution.scan_interval_seconds * 1000);
            }
        }
    }

    /**
     * Run a single trading cycle.
     */
    private async runCycle(cycleId: string, context: CycleContext): Promise<void> {
        // ── Step 1: Scan ─────────────────────────────────────────────────

        const scanResult = await this.scanner.scan(cycleId);
        this.state.recordApiUsage(scanResult.usage);

        if (!scanResult.signal) {
            logger.info('No signal detected', { cycleId });
            return;
        }

        context.signal = scanResult.signal;
        const signalId = this.state.recordSignal(cycleId, scanResult.signal);

        logWithMeta(logger, 'info', 'Signal detected — proceeding to decision', {
            cycleId,
            data: {
                type: scanResult.signal.type,
                instrument: scanResult.signal.instrument,
                direction: scanResult.signal.direction,
                confidence: scanResult.signal.confidence,
            },
        });

        // ── Step 2: Decide ───────────────────────────────────────────────

        // Check if trading is locked before spending API credits on decision
        if (this.state.isTradingLocked()) {
            logger.warn('Trading locked — skipping decision phase', { cycleId });
            return;
        }

        const decisionResult = await this.decisionMaker.decide(scanResult.signal, cycleId);
        for (const usage of decisionResult.usageRecords) {
            this.state.recordApiUsage(usage);
        }

        context.decision = decisionResult.decision;
        const decisionId = this.state.recordDecision(cycleId, signalId, decisionResult.decision);

        if (decisionResult.decision.action === 'SKIP') {
            logger.info('Decision: SKIP', {
                cycleId,
                data: { reasoning: decisionResult.decision.reasoning },
            });
            return;
        }

        logWithMeta(logger, 'info', 'Trade decision made', {
            cycleId,
            data: {
                action: decisionResult.decision.action,
                instrument: decisionResult.decision.instrument,
                size: decisionResult.decision.size,
                price: decisionResult.decision.price,
            },
        });

        // ── Step 3: Validate ─────────────────────────────────────────────

        const validateResult = await this.validator.validate(decisionResult.decision, cycleId);
        if (validateResult.usage) {
            this.state.recordApiUsage(validateResult.usage);
        }

        context.validation = validateResult.validation;

        if (!validateResult.validation.approved) {
            logger.warn('🚫 Trade VETOED by risk validator', {
                cycleId,
                data: { reason: validateResult.validation.reason },
            });

            // Record the vetoed order
            this.state.recordOrder(
                cycleId,
                decisionId,
                decisionResult.decision.instrument,
                decisionResult.decision.action === 'BUY' ? 'buy' : 'sell',
                decisionResult.decision.size,
                decisionResult.decision.price ?? null,
                'rejected',
                this.isShadowMode,
                validateResult.validation.reason,
            );
            return;
        }

        // ── Step 4: Execute ──────────────────────────────────────────────

        logger.info('✅ Trade approved — executing', { cycleId });

        const orderResult = await this.executor.execute(decisionResult.decision, cycleId);
        context.orderResult = orderResult;

        // Record the order
        const orderId = this.state.recordOrder(
            cycleId,
            decisionId,
            decisionResult.decision.instrument,
            decisionResult.decision.action === 'BUY' ? 'buy' : 'sell',
            decisionResult.decision.size,
            decisionResult.decision.price ?? null,
            orderResult.status,
            this.isShadowMode,
        );

        // Update with fill result
        this.state.updateOrderResult(orderId, orderResult);

        logWithMeta(logger, 'info', `Trade ${orderResult.status}`, {
            cycleId,
            data: {
                orderId: orderResult.orderId,
                status: orderResult.status,
                fillPrice: orderResult.fillPrice,
                fillSize: orderResult.fillSize,
                isShadow: this.isShadowMode,
            },
        });

        // ── Step 5: Update state ─────────────────────────────────────────

        // Sync latest positions after trade
        await this.syncPositions();
    }

    /**
     * Check OKX API connectivity by fetching BTC-USDT ticker.
     */
    private async checkConnectivity(): Promise<void> {
        try {
            const profile = process.env['OKX_PROFILE'] ?? 'demo';
            const { stdout } = await execFileAsync('okx', [
                '--profile', profile, '--json',
                'market', 'ticker', 'BTC-USDT',
            ], { timeout: 15000 });

            const ticker = JSON.parse(stdout) as Record<string, string>;
            const price = ticker['last'] ?? 'unknown';
            logger.info(`OKX API connected — BTC-USDT: $${price}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn(`OKX API connectivity check failed: ${msg}`);
            logger.warn('The bot will attempt to connect on each scan cycle');
        }
    }

    /**
     * Sync current positions from OKX.
     */
    private async syncPositions(): Promise<void> {
        try {
            const profile = process.env['OKX_PROFILE'] ?? 'demo';
            const { stdout } = await execFileAsync('okx', [
                '--profile', profile, '--json',
                'account', 'positions',
            ], { timeout: 15000 });

            const positions = JSON.parse(stdout) as Array<Record<string, string>>;
            const positionData: PositionData[] = positions.map((p) => ({
                instId: String(p['instId'] ?? ''),
                posSide: (p['posSide'] ?? 'net') as 'long' | 'short' | 'net',
                pos: parseFloat(p['pos'] ?? '0'),
                avgPx: parseFloat(p['avgPx'] ?? '0'),
                upl: parseFloat(p['upl'] ?? '0'),
                lever: parseFloat(p['lever'] ?? '1'),
                mgnMode: (p['mgnMode'] ?? 'cross') as 'cross' | 'isolated',
                notionalUsd: parseFloat(p['notionalUsd'] ?? '0'),
            }));

            this.state.syncPositions(positionData);
            logger.info(`Positions synced: ${positionData.length} open`);
        } catch {
            logger.warn('Position sync failed — will retry next cycle');
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            this.loopTimer = setTimeout(resolve, ms);
        });
    }
}
