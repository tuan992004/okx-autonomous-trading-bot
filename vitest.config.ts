import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        globals: true,
        include: ['packages/*/src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['packages/*/src/**/*.ts'],
            exclude: ['**/*.test.ts', '**/index.ts'],
        },
    },
    resolve: {
        alias: {
            '@okx-bot/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
            '@okx-bot/state': path.resolve(__dirname, 'packages/state/src/index.ts'),
            '@okx-bot/scanner': path.resolve(__dirname, 'packages/scanner/src/index.ts'),
            '@okx-bot/decision': path.resolve(__dirname, 'packages/decision/src/index.ts'),
            '@okx-bot/validator': path.resolve(__dirname, 'packages/validator/src/index.ts'),
            '@okx-bot/journal': path.resolve(__dirname, 'packages/journal/src/index.ts'),
            '@okx-bot/orchestrator': path.resolve(__dirname, 'packages/orchestrator/src/index.ts'),
        },
    },
});
