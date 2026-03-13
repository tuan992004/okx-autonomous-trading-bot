# OKX Autonomous Trading Bot

A production-grade, multi-agent autonomous crypto trading bot built on the [OKX Agent Trade Kit](https://github.com/okx/agent-trade-kit).

## Architecture

```
                    ┌──────────────────────────────────┐
                    │      Orchestrator (Node.js)       │
                    │                                  │
  Market Data ──────►  Haiku Scanner (30s loop)        │
                    │         │                        │
                    │    [if signal found]              │
                    │         ▼                        │
                    │  Sonnet Decision Maker            │
                    │    (with OKX read tools)          │
                    │         │                        │
                    │    [before any order]             │
                    │         ▼                        │
                    │  Risk Validator (code + Haiku)    │
                    │         │                        │
                    │    [if approved]                  │
                    │         ▼                        │
                    │   Trade Executor (live/shadow)    │
                    │         │                        │
                    │         ▼                        │
                    │  SQLite State + Async Journal     │
                    └──────────────────────────────────┘
```

**Models:**
- `claude-haiku-4-5` — High-frequency scanner, risk validator
- `claude-sonnet-4-6` — Strategy decision maker (default)
- `claude-opus-4-6` — Complex strategies (flag-gated, disabled by default)

## Project Structure

```
okx-bot/
├── packages/
│   ├── shared/          # Types, logger, config, Anthropic client
│   ├── state/           # SQLite persistence (better-sqlite3)
│   ├── scanner/         # Haiku-powered market signal detector
│   ├── decision/        # Sonnet-powered strategy executor
│   ├── validator/       # Risk gate (hardcoded + Haiku checks)
│   ├── journal/         # Async trade logger
│   └── orchestrator/    # Main event loop & coordinator
├── config/
│   ├── strategy.toml    # Instruments, signals, models
│   └── risk.toml        # Risk limits, kill switch
├── scripts/
│   ├── shadow-mode.ts   # Simulation mode (default)
│   └── backtest.ts      # Historical replay (stub)
├── docker-compose.yml
└── Dockerfile
```

## Quick Start

### Prerequisites

- Node.js >= 18
- pnpm >= 9
- OKX API credentials (create at OKX → Profile → API)
- Anthropic API key

### 1. Install Dependencies

```bash
cd c:\cyber\bot
pnpm install
```

### 2. Configure API Keys

```bash
# Copy environment template
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Set up OKX credentials
npm install -g @okx_ai/okx-trade-cli
okx config init
# Follow the interactive wizard — use "demo" profile for paper trading
```

### 3. Run in Shadow Mode (Recommended First)

```bash
pnpm shadow
```

This runs the full pipeline but simulates all trades at mid-price. No real orders are placed.

### 4. Run Live (When Ready)

```bash
# ⚠️ CAUTION: Real money at risk
LIVE_TRADING=true pnpm dev
```

### 5. Run with Docker

```bash
docker compose up -d
# View logs
docker compose logs -f
```

## Configuration

### `config/strategy.toml`

| Setting | Default | Description |
|---------|---------|-------------|
| `instruments.spot` | `["BTC-USDT", "ETH-USDT"]` | Spot pairs to scan |
| `instruments.swap` | `["BTC-USDT-SWAP"]` | Perpetual swap pairs |
| `signals.momentum_threshold_pct` | `2.0` | Min % move for momentum signal |
| `signals.rsi_oversold` / `rsi_overbought` | `30` / `70` | RSI thresholds |
| `signals.volume_spike_multiplier` | `2.5` | Volume vs 20-period average |
| `execution.default_order_type` | `"limit"` | Default order type |
| `execution.scan_interval_seconds` | `30` | Main loop interval |

### `config/risk.toml`

| Setting | Default | Description |
|---------|---------|-------------|
| `limits.max_order_usdt` | `1000` | Max single order value |
| `limits.max_total_exposure_usdt` | `5000` | Max total open value |
| `limits.max_daily_loss_usdt` | `200` | Daily loss kill switch |
| `limits.max_open_positions` | `3` | Max concurrent positions |
| `killswitch.consecutive_loss_count` | `5` | Pause after N losses |
| `killswitch.cooldown_minutes` | `60` | Cooldown duration |

### Hardcoded Safety Limits (cannot be overridden)

```typescript
maxSingleOrderUSDT: 1000
maxTotalExposureUSDT: 5000
maxDailyLossUSDT: 200
allowedInstrumentTypes: ['SPOT', 'SWAP']
```

## Testing

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch
```

## Estimated API Costs

| Component | Model | Calls/Hour | Est. Cost/Hour |
|-----------|-------|------------|----------------|
| Scanner | Haiku 4.5 | 120 | ~$0.05 |
| Decision | Sonnet 4.6 | 0-10 | ~$0.01-0.50 |
| Validator | Haiku 4.5 | 0-10 | ~$0.01 |
| **Total** | | | **~$0.07-0.56** |

Costs are reduced with prompt caching (system prompts cached across calls). Actual costs depend on signal frequency.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `LIVE_TRADING` | `false` | Enable live trading |
| `NODE_ENV` | `development` | Environment |
| `LOG_LEVEL` | `info` | Log verbosity |
| `OKX_PROFILE` | `demo` | OKX config profile |

## Safety Guarantees

1. **Default to shadow mode** — No real trades unless `LIVE_TRADING=true`
2. **Two-layer validation** — Hardcoded code limits + LLM risk checker
3. **Read-only LLM tools** — Decision maker can only READ market data, never place orders
4. **Kill switch** — Auto-pauses after consecutive losses or daily loss limit
5. **Duplicate detection** — Prevents repeated orders within 5 minutes
6. **Full audit trail** — Every signal, decision, and order logged to SQLite
7. **Crash-safe** — Resumes from persisted state without duplicate orders

## License

Private — internal use only.
