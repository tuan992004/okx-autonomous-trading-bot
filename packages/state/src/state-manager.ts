import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';
import type {
    Signal,
    TradeDecision,
    ValidationResult,
    OrderResult,
    ApiUsageRecord,
    PositionData,
} from '@okx-bot/shared';

const DB_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'bot.db');

export interface DailyStatsRow {
    date: string;
    total_pnl: number;
    win_count: number;
    loss_count: number;
    trade_count: number;
    api_cost_usd: number;
    consecutive_losses: number;
    is_locked: number;
    locked_until: string | null;
}

export interface OrderRow {
    id: number;
    cycle_id: string;
    decision_id: number | null;
    okx_order_id: string | null;
    instrument: string;
    side: string;
    size: number;
    price: number | null;
    status: string;
    fill_price: number | null;
    fill_size: number | null;
    veto_reason: string | null;
    is_shadow: number;
    timestamp: string;
}

export interface PositionRow {
    id: number;
    instrument: string;
    side: string;
    size: number;
    avg_price: number;
    unrealized_pnl: number;
    notional_usd: number;
    leverage: number;
    margin_mode: string;
    updated_at: string;
}

/**
 * Persistent state manager backed by SQLite (via sql.js — pure JS).
 * Must be initialized with `await StateManager.create()`.
 */
export class StateManager {
    private db: SqlJsDatabase;
    private dbPath: string | null;

    private constructor(db: SqlJsDatabase, dbPath: string | null) {
        this.db = db;
        this.dbPath = dbPath;
    }

    /**
     * Create a new StateManager instance.
     * @param dbPath - path to SQLite file, or ':memory:' for in-memory
     */
    static async create(dbPath?: string): Promise<StateManager> {
        const resolvedPath = dbPath ?? DB_PATH;
        const isMemory = resolvedPath === ':memory:';

        const SQL = await initSqlJs();

        let db: SqlJsDatabase;
        if (!isMemory && fs.existsSync(resolvedPath)) {
            const buffer = fs.readFileSync(resolvedPath);
            db = new SQL.Database(buffer);
        } else {
            db = new SQL.Database();
        }

        // Create directory if needed
        if (!isMemory) {
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        db.run(SCHEMA_SQL);

        return new StateManager(db, isMemory ? null : resolvedPath);
    }

    /**
     * Persist database to disk.
     */
    save(): void {
        if (this.dbPath) {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
        }
    }

    close(): void {
        this.save();
        this.db.close();
    }

    // ─── Helper ───────────────────────────────────────────────────────

    private run(sql: string, params: unknown[] = []): void {
        this.db.run(sql, params as (string | number | null | Uint8Array)[]);
    }

    private getOne<T>(sql: string, params: unknown[] = []): T | undefined {
        const stmt = this.db.prepare(sql);
        stmt.bind(params as (string | number | null | Uint8Array)[]);
        if (stmt.step()) {
            const row = stmt.getAsObject() as T;
            stmt.free();
            return row;
        }
        stmt.free();
        return undefined;
    }

    private getAll<T>(sql: string, params: unknown[] = []): T[] {
        const results: T[] = [];
        const stmt = this.db.prepare(sql);
        stmt.bind(params as (string | number | null | Uint8Array)[]);
        while (stmt.step()) {
            results.push(stmt.getAsObject() as T);
        }
        stmt.free();
        return results;
    }

    /**
     * Execute a function inside a SQLite transaction.
     * Automatically rolls back on error, commits on success, and saves to disk.
     */
    private withTransaction<T>(fn: () => T): T {
        this.db.run('BEGIN TRANSACTION');
        try {
            const result = fn();
            this.db.run('COMMIT');
            this.save();
            return result;
        } catch (error) {
            this.db.run('ROLLBACK');
            throw error;
        }
    }

    private getLastInsertId(): number {
        const row = this.getOne<{ id: number }>('SELECT last_insert_rowid() as id');
        return row?.id ?? 0;
    }

    // ─── Signals ──────────────────────────────────────────────────────

    recordSignal(cycleId: string, signal: Signal): number {
        return this.withTransaction(() => {
            this.run(
                `INSERT INTO signals (cycle_id, instrument, signal_type, direction, confidence, raw_data, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [cycleId, signal.instrument, signal.type, signal.direction, signal.confidence, JSON.stringify(signal.data), signal.timestamp],
            );
            return this.getLastInsertId();
        });
    }

    // ─── Decisions ────────────────────────────────────────────────────

    recordDecision(cycleId: string, signalId: number, decision: TradeDecision): number {
        return this.withTransaction(() => {
            this.run(
                `INSERT INTO decisions (cycle_id, signal_id, action, instrument, size, price, stop_loss, take_profit, order_type, reasoning, thinking_content, model, tool_call_count, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    cycleId, signalId, decision.action, decision.instrument, decision.size,
                    decision.price ?? null, decision.stopLoss ?? null, decision.takeProfit ?? null,
                    decision.orderType, decision.reasoning, decision.thinkingContent ?? null,
                    decision.model, decision.toolCallCount, new Date().toISOString(),
                ],
            );
            return this.getLastInsertId();
        });
    }

    // ─── Orders ───────────────────────────────────────────────────────

    recordOrder(
        cycleId: string,
        decisionId: number,
        instrument: string,
        side: string,
        size: number,
        price: number | null,
        status: string,
        isShadow: boolean,
        vetoReason?: string,
    ): number {
        return this.withTransaction(() => {
            this.run(
                `INSERT INTO orders (cycle_id, decision_id, instrument, side, size, price, status, veto_reason, is_shadow, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [cycleId, decisionId, instrument, side, size, price, status, vetoReason ?? null, isShadow ? 1 : 0, new Date().toISOString()],
            );
            return this.getLastInsertId();
        });
    }

    updateOrderResult(orderId: number, result: OrderResult): void {
        this.withTransaction(() => {
            this.run(
                `UPDATE orders SET okx_order_id = ?, status = ?, fill_price = ?, fill_size = ? WHERE id = ?`,
                [result.orderId, result.status, result.fillPrice, result.fillSize, orderId],
            );
        });
    }

    getRecentOrders(instrument: string, minutes: number = 5): OrderRow[] {
        const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
        return this.getAll<OrderRow>(
            `SELECT * FROM orders WHERE instrument = ? AND timestamp > ? AND status != 'rejected' ORDER BY timestamp DESC`,
            [instrument, cutoff],
        );
    }

    checkDuplicateOrder(instrument: string, side: string, withinMinutes: number = 5): boolean {
        const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
        const row = this.getOne<{ count: number }>(
            `SELECT COUNT(*) as count FROM orders WHERE instrument = ? AND side = ? AND timestamp > ? AND status NOT IN ('rejected', 'cancelled')`,
            [instrument, side, cutoff],
        );
        return (row?.count ?? 0) > 0;
    }

    // ─── Positions ────────────────────────────────────────────────────

    syncPositions(positions: PositionData[]): void {
        this.withTransaction(() => {
            this.run('DELETE FROM positions');
            for (const pos of positions) {
                this.run(
                    `INSERT OR REPLACE INTO positions (instrument, side, size, avg_price, unrealized_pnl, notional_usd, leverage, margin_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [pos.instId, pos.posSide, pos.pos, pos.avgPx, pos.upl, pos.notionalUsd, pos.lever, pos.mgnMode, new Date().toISOString()],
                );
            }
        });
    }

    getOpenPositions(): PositionRow[] {
        return this.getAll<PositionRow>('SELECT * FROM positions WHERE size > 0');
    }

    getOpenPositionCount(): number {
        const row = this.getOne<{ count: number }>('SELECT COUNT(*) as count FROM positions WHERE size > 0');
        return row?.count ?? 0;
    }

    getTotalExposureUsd(): number {
        const row = this.getOne<{ total: number }>('SELECT COALESCE(SUM(notional_usd), 0) as total FROM positions WHERE size > 0');
        return row?.total ?? 0;
    }

    // ─── Daily Stats ──────────────────────────────────────────────────

    private getToday(): string {
        return new Date().toISOString().slice(0, 10);
    }

    ensureDailyStats(): void {
        const today = this.getToday();
        const existing = this.getOne<{ date: string }>('SELECT date FROM daily_stats WHERE date = ?', [today]);
        if (!existing) {
            this.run(
                `INSERT INTO daily_stats (date, total_pnl, win_count, loss_count, trade_count, api_cost_usd, consecutive_losses, is_locked, updated_at)
         VALUES (?, 0, 0, 0, 0, 0, 0, 0, datetime('now'))`,
                [today],
            );
        }
    }

    getDailyStats(): DailyStatsRow | null {
        this.ensureDailyStats();
        const today = this.getToday();
        return this.getOne<DailyStatsRow>('SELECT * FROM daily_stats WHERE date = ?', [today]) ?? null;
    }

    getDailyLoss(): number {
        const stats = this.getDailyStats();
        if (!stats) return 0;
        return stats.total_pnl < 0 ? Math.abs(stats.total_pnl) : 0;
    }

    getConsecutiveLosses(): number {
        const stats = this.getDailyStats();
        return stats?.consecutive_losses ?? 0;
    }

    updateDailyPnl(pnl: number): void {
        this.withTransaction(() => {
            this.ensureDailyStats();
            const today = this.getToday();
            const isLoss = pnl < 0;

            if (isLoss) {
                this.run(
                    `UPDATE daily_stats SET total_pnl = total_pnl + ?, loss_count = loss_count + 1, trade_count = trade_count + 1, consecutive_losses = consecutive_losses + 1, updated_at = datetime('now') WHERE date = ?`,
                    [pnl, today],
                );
            } else if (pnl > 0) {
                this.run(
                    `UPDATE daily_stats SET total_pnl = total_pnl + ?, win_count = win_count + 1, trade_count = trade_count + 1, consecutive_losses = 0, updated_at = datetime('now') WHERE date = ?`,
                    [pnl, today],
                );
            }
        });
    }

    addDailyApiCost(costUsd: number): void {
        this.ensureDailyStats();
        const today = this.getToday();
        this.run(`UPDATE daily_stats SET api_cost_usd = api_cost_usd + ?, updated_at = datetime('now') WHERE date = ?`, [costUsd, today]);
    }

    lockTradingForDay(untilTime?: string): void {
        this.ensureDailyStats();
        const today = this.getToday();
        this.run(`UPDATE daily_stats SET is_locked = 1, locked_until = ?, updated_at = datetime('now') WHERE date = ?`, [untilTime ?? null, today]);
        this.save();
    }

    isTradingLocked(): boolean {
        const stats = this.getDailyStats();
        if (!stats) return false;

        if (stats.is_locked) {
            if (stats.locked_until) {
                const now = new Date();
                const lockEnd = new Date(stats.locked_until);
                if (now >= lockEnd) {
                    this.run(`UPDATE daily_stats SET is_locked = 0, locked_until = NULL, updated_at = datetime('now') WHERE date = ?`, [stats.date]);
                    this.save();
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    // ─── API Usage ────────────────────────────────────────────────────

    recordApiUsage(record: ApiUsageRecord): number {
        return this.withTransaction(() => {
            this.run(
                `INSERT INTO api_usage (cycle_id, component, model, input_tokens, cached_tokens, output_tokens, cost_usd, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [record.cycleId, record.component, record.model, record.inputTokens, record.cachedTokens, record.outputTokens, record.costUsd, record.timestamp],
            );
            this.addDailyApiCost(record.costUsd);
            return this.getLastInsertId();
        });
    }

    getDailyApiCost(): number {
        const stats = this.getDailyStats();
        return stats?.api_cost_usd ?? 0;
    }

    getTotalApiUsage(): { totalCost: number; totalInputTokens: number; totalCachedTokens: number; totalOutputTokens: number } {
        const today = this.getToday();
        const row = this.getOne<{
            totalCost: number;
            totalInputTokens: number;
            totalCachedTokens: number;
            totalOutputTokens: number;
        }>(
            `SELECT COALESCE(SUM(cost_usd), 0) as totalCost, COALESCE(SUM(input_tokens), 0) as totalInputTokens, COALESCE(SUM(cached_tokens), 0) as totalCachedTokens, COALESCE(SUM(output_tokens), 0) as totalOutputTokens FROM api_usage WHERE timestamp >= ?`,
            [today + 'T00:00:00.000Z'],
        );
        return row ?? { totalCost: 0, totalInputTokens: 0, totalCachedTokens: 0, totalOutputTokens: 0 };
    }

    // ─── Maintenance ──────────────────────────────────────────────────

    /**
     * Prune records older than `days` from signals, decisions, orders, and api_usage.
     * Call periodically (e.g., on startup) to prevent unbounded DB growth.
     */
    pruneOldRecords(days: number = 30): void {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        this.withTransaction(() => {
            this.run('DELETE FROM signals WHERE timestamp < ?', [cutoff]);
            this.run('DELETE FROM decisions WHERE timestamp < ?', [cutoff]);
            this.run('DELETE FROM orders WHERE timestamp < ?', [cutoff]);
            this.run('DELETE FROM api_usage WHERE timestamp < ?', [cutoff]);
            this.run('DELETE FROM daily_stats WHERE date < ?', [cutoff.slice(0, 10)]);
        });
    }
}
