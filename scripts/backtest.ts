/**
 * Backtest — Offline strategy backtesting.
 *
 * Reads historical candle data and replays through the scanner + decision pipeline.
 * This is a placeholder/stub for future implementation.
 *
 * Usage:
 *   npx tsx scripts/backtest.ts --instrument BTC-USDT --days 30
 */

import 'dotenv/config';
import { createLogger } from '../packages/shared/src/logger.js';

const logger = createLogger('orchestrator');

logger.info('╔═══════════════════════════════════════════════════╗');
logger.info('║      📊 BACKTEST MODE — Historical Replay         ║');
logger.info('╚═══════════════════════════════════════════════════╝');

logger.info('Backtest mode is currently a stub.');
logger.info('To implement:');
logger.info('  1. Fetch historical candles via market_get_history_candles');
logger.info('  2. Replay each candle through the scanner');
logger.info('  3. Record simulated decisions and P&L');
logger.info('  4. Output summary statistics');

process.exit(0);
