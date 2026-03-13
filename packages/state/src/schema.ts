/**
 * SQLite schema for the trading bot state.
 * All tables are created idempotently (IF NOT EXISTS).
 */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL,
    instrument TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    confidence REAL NOT NULL,
    raw_data TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL,
    signal_id INTEGER REFERENCES signals(id),
    action TEXT NOT NULL,
    instrument TEXT NOT NULL,
    size REAL NOT NULL,
    price REAL,
    stop_loss REAL,
    take_profit REAL,
    order_type TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    thinking_content TEXT,
    model TEXT NOT NULL,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL,
    decision_id INTEGER REFERENCES decisions(id),
    okx_order_id TEXT,
    instrument TEXT NOT NULL,
    side TEXT NOT NULL,
    size REAL NOT NULL,
    price REAL,
    status TEXT NOT NULL,
    fill_price REAL,
    fill_size REAL,
    veto_reason TEXT,
    is_shadow INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instrument TEXT NOT NULL UNIQUE,
    side TEXT NOT NULL,
    size REAL NOT NULL,
    avg_price REAL NOT NULL,
    unrealized_pnl REAL NOT NULL DEFAULT 0,
    notional_usd REAL NOT NULL DEFAULT 0,
    leverage REAL NOT NULL DEFAULT 1,
    margin_mode TEXT NOT NULL DEFAULT 'cash',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY,
    total_pnl REAL NOT NULL DEFAULT 0,
    win_count INTEGER NOT NULL DEFAULT 0,
    loss_count INTEGER NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    api_cost_usd REAL NOT NULL DEFAULT 0,
    consecutive_losses INTEGER NOT NULL DEFAULT 0,
    is_locked INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL,
    component TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
  CREATE INDEX IF NOT EXISTS idx_signals_instrument ON signals(instrument);
  CREATE INDEX IF NOT EXISTS idx_decisions_cycle ON decisions(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_orders_cycle ON orders(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_orders_instrument_status ON orders(instrument, status);
  CREATE INDEX IF NOT EXISTS idx_orders_timestamp ON orders(timestamp);
  CREATE INDEX IF NOT EXISTS idx_api_usage_timestamp ON api_usage(timestamp);
`;
