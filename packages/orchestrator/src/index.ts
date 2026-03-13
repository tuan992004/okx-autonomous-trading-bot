import 'dotenv/config';
import { Orchestrator } from './orchestrator.js';
import { createLogger } from '@okx-bot/shared';

const logger = createLogger('orchestrator');

async function main(): Promise<void> {
    const orchestrator = await Orchestrator.create();

    // Graceful shutdown handlers
    const shutdown = async (signal: string): Promise<void> => {
        logger.info(`Received ${signal} — initiating graceful shutdown`);
        await orchestrator.shutdown(signal);
        process.exit(0);
    };

    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception', { data: { error: error.message, stack: error.stack } });
        void shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled rejection', { data: { reason: String(reason) } });
    });

    // Start the bot
    try {
        await orchestrator.start();
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Fatal startup error: ${msg}`);
        await orchestrator.shutdown('startup-error');
        process.exit(1);
    }
}

main().catch((err: unknown) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
