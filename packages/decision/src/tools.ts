import type Anthropic from '@anthropic-ai/sdk';

/**
 * OKX tool definitions for the Anthropic API.
 * These are loaded as tool schemas in the decision maker's Sonnet calls.
 * The decision maker uses these to reason about and propose trades.
 *
 * NOTE: We only include READ tools here. Write tools (place_order etc.)
 * are NOT exposed to the LLM — the decision maker outputs a TradeDecision
 * and the orchestrator handles execution through the validator gate.
 */
export const OKX_READ_TOOLS: Anthropic.Tool[] = [
    {
        name: 'get_ticker',
        description: 'Get current ticker data for an instrument (last price, bid/ask, 24h volume)',
        input_schema: {
            type: 'object' as const,
            properties: {
                instId: { type: 'string', description: 'Instrument ID, e.g. BTC-USDT or BTC-USDT-SWAP' },
            },
            required: ['instId'],
        },
    },
    {
        name: 'get_candles',
        description: 'Get candlestick data for an instrument',
        input_schema: {
            type: 'object' as const,
            properties: {
                instId: { type: 'string', description: 'Instrument ID' },
                bar: { type: 'string', description: 'Candle interval: 1m, 5m, 15m, 1H, 4H, 1D', default: '5m' },
                limit: { type: 'number', description: 'Number of candles (max 300)', default: 20 },
            },
            required: ['instId'],
        },
    },
    {
        name: 'get_orderbook',
        description: 'Get order book depth for an instrument',
        input_schema: {
            type: 'object' as const,
            properties: {
                instId: { type: 'string', description: 'Instrument ID' },
                depth: { type: 'number', description: 'Number of depth levels (max 400)', default: 10 },
            },
            required: ['instId'],
        },
    },
    {
        name: 'get_account_balance',
        description: 'Get trading account balance by currency or all currencies',
        input_schema: {
            type: 'object' as const,
            properties: {
                ccy: { type: 'string', description: 'Currency, e.g. USDT, BTC. Omit for all.' },
            },
            required: [],
        },
    },
    {
        name: 'get_positions',
        description: 'Get current open positions across all instruments',
        input_schema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_open_orders',
        description: 'Get currently open/pending orders',
        input_schema: {
            type: 'object' as const,
            properties: {
                instId: { type: 'string', description: 'Filter by instrument ID (optional)' },
            },
            required: [],
        },
    },
    {
        name: 'get_recent_fills',
        description: 'Get recent trade fills/executions',
        input_schema: {
            type: 'object' as const,
            properties: {
                instId: { type: 'string', description: 'Filter by instrument ID (optional)' },
                limit: { type: 'number', description: 'Number of fills to return', default: 10 },
            },
            required: [],
        },
    },
    {
        name: 'get_funding_rate',
        description: 'Get current funding rate for a perpetual swap instrument',
        input_schema: {
            type: 'object' as const,
            properties: {
                instId: { type: 'string', description: 'Swap instrument ID, e.g. BTC-USDT-SWAP' },
            },
            required: ['instId'],
        },
    },
];

/**
 * Execute a tool call by delegating to the okx-trade-cli.
 */
export async function executeToolCall(
    toolName: string,
    toolInput: Record<string, unknown>,
): Promise<string> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const profile = process.env['OKX_PROFILE'] ?? 'demo';

    try {
        const cliArgs = buildCliArgs(toolName, toolInput, profile);
        const { stdout } = await execFileAsync('okx', cliArgs, {
            timeout: 15000,
            maxBuffer: 1024 * 1024,
        });
        return stdout;
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: true, message: msg });
    }
}

function buildCliArgs(toolName: string, input: Record<string, unknown>, profile: string): string[] {
    const args = ['--profile', profile, '--json'];

    switch (toolName) {
        case 'get_ticker':
            args.push('market', 'ticker', String(input['instId']));
            break;
        case 'get_candles':
            args.push('market', 'candles', String(input['instId']));
            if (input['bar']) args.push('--bar', String(input['bar']));
            if (input['limit']) args.push('--limit', String(input['limit']));
            break;
        case 'get_orderbook':
            args.push('market', 'orderbook', String(input['instId']));
            if (input['depth']) args.push('--sz', String(input['depth']));
            break;
        case 'get_account_balance':
            args.push('account', 'balance');
            if (input['ccy']) args.push(String(input['ccy']));
            break;
        case 'get_positions':
            args.push('account', 'positions');
            break;
        case 'get_open_orders':
            args.push('spot', 'orders');
            if (input['instId']) args.push('--instId', String(input['instId']));
            break;
        case 'get_recent_fills':
            args.push('spot', 'fills');
            if (input['instId']) args.push('--instId', String(input['instId']));
            break;
        case 'get_funding_rate':
            args.push('market', 'funding-rate', String(input['instId']));
            break;
        default:
            return ['--help'];
    }

    return args;
}
