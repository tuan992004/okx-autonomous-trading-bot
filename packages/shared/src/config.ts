import fs from 'node:fs';
import path from 'node:path';
import TOML from 'toml';
import { StrategyConfigSchema, RiskConfigSchema } from './types.js';
import type { StrategyConfig, RiskConfig } from './types.js';

const CONFIG_DIR = path.resolve(process.cwd(), 'config');

/**
 * Load and validate strategy.toml configuration.
 * @throws {Error} if file is missing or fails validation.
 */
export function loadStrategyConfig(configPath?: string): StrategyConfig {
    const filePath = configPath ?? path.join(CONFIG_DIR, 'strategy.toml');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = TOML.parse(raw);
    const result = StrategyConfigSchema.safeParse(parsed);

    if (!result.success) {
        const errors = result.error.issues
            .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid strategy.toml:\n${errors}`);
    }

    return result.data;
}

/**
 * Load and validate risk.toml configuration.
 * @throws {Error} if file is missing or fails validation.
 */
export function loadRiskConfig(configPath?: string): RiskConfig {
    const filePath = configPath ?? path.join(CONFIG_DIR, 'risk.toml');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = TOML.parse(raw);
    const result = RiskConfigSchema.safeParse(parsed);

    if (!result.success) {
        const errors = result.error.issues
            .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid risk.toml:\n${errors}`);
    }

    return result.data;
}

/**
 * Get all configured instruments (spot + swap).
 */
export function getAllInstruments(config: StrategyConfig): string[] {
    return [...config.instruments.spot, ...config.instruments.swap];
}

/**
 * Check if an instrument is a swap/perpetual.
 */
export function isSwapInstrument(instId: string): boolean {
    return instId.endsWith('-SWAP');
}
