/**
 * Shadow Mode — Run the full trading pipeline in simulation mode.
 *
 * This script forces LIVE_TRADING=false and starts the orchestrator.
 * All trades are simulated at mid-price. No real orders are placed.
 *
 * Usage:
 *   pnpm shadow
 *   npx tsx scripts/shadow-mode.ts
 */

import 'dotenv/config';

// Force shadow mode regardless of .env
process.env['LIVE_TRADING'] = 'false';

const { Orchestrator } = await import('../packages/orchestrator/src/orchestrator.js');
const { createLogger } = await import('../packages/shared/src/logger.js');

const logger = createLogger('orchestrator');

logger.info('╔═══════════════════════════════════════════════════╗');
logger.info('║      🔮 SHADOW MODE — Simulation Only 🔮         ║');
logger.info('║  No real orders will be placed on OKX             ║');
logger.info('║  All trades simulated at current mid-price        ║');
logger.info('╚═══════════════════════════════════════════════════╝');

const orchestrator = await Orchestrator.create();

const shutdown = async (signal: string): Promise<void> => {
    logger.info(`\nReceived ${signal} — generating shadow report...`);
    await orchestrator.shutdown(signal);
    process.exit(0);
};

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
    await orchestrator.start();
} catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Shadow mode fatal error: ${msg}`);
    await orchestrator.shutdown('error');
    process.exit(1);
}
