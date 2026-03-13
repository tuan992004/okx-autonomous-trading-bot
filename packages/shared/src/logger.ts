import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'node:path';
import type { ComponentName, LogMeta } from './types.js';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

/**
 * Custom format that merges component metadata into structured JSON.
 */
const structuredFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
);

/**
 * Colorized console format for development readability.
 */
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, component, cycleId, ...rest }) => {
        const comp = component ? `[${component}]` : '';
        const cycle = cycleId ? ` (${String(cycleId).slice(0, 8)})` : '';
        const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
        return `${String(timestamp)} ${level} ${comp}${cycle} ${String(message)}${extra}`;
    }),
);

/**
 * Root logger instance.
 */
const rootLogger = winston.createLogger({
    level: process.env['LOG_LEVEL'] ?? 'info',
    format: structuredFormat,
    defaultMeta: {},
    transports: [
        // Console output with colorization
        new winston.transports.Console({
            format: process.env['NODE_ENV'] === 'production' ? structuredFormat : consoleFormat,
        }),
        // Daily rotating file for production auditing
        new DailyRotateFile({
            dirname: LOG_DIR,
            filename: 'bot-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '30d',
            maxSize: '50m',
            format: structuredFormat,
        }),
    ],
});

/**
 * Create a child logger scoped to a specific component.
 */
export function createLogger(component: ComponentName): winston.Logger {
    return rootLogger.child({ component });
}

/**
 * Log with full cycle metadata — use for structured trade cycle logging.
 */
export function logWithMeta(
    logger: winston.Logger,
    level: 'info' | 'warn' | 'error',
    message: string,
    meta: Partial<LogMeta>,
): void {
    logger.log(level, message, {
        cycleId: meta.cycleId,
        model: meta.model,
        tokensUsed: meta.tokensUsed,
        cachedTokens: meta.cachedTokens,
        estimatedCostUSD: meta.estimatedCostUSD,
        data: meta.data,
    });
}

export { rootLogger };
