FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Install okx-trade-cli globally
RUN npm install -g @okx_ai/okx-trade-mcp @okx_ai/okx-trade-cli

# ─── Dependencies ─────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/state/package.json packages/state/
COPY packages/scanner/package.json packages/scanner/
COPY packages/decision/package.json packages/decision/
COPY packages/validator/package.json packages/validator/
COPY packages/journal/package.json packages/journal/
COPY packages/orchestrator/package.json packages/orchestrator/
RUN pnpm install --frozen-lockfile || pnpm install

# ─── Build ────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm build

# ─── Production ───────────────────────────────────────────────────────
FROM base AS production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/*/node_modules ./packages/
COPY --from=build /app/packages/*/dist ./packages/
COPY --from=build /app/package.json .
COPY --from=build /app/config ./config
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/state/package.json ./packages/state/
COPY --from=build /app/packages/scanner/package.json ./packages/scanner/
COPY --from=build /app/packages/decision/package.json ./packages/decision/
COPY --from=build /app/packages/validator/package.json ./packages/validator/
COPY --from=build /app/packages/journal/package.json ./packages/journal/
COPY --from=build /app/packages/orchestrator/package.json ./packages/orchestrator/

# Create data and logs directories with correct ownership
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs

ENV NODE_ENV=production
ENV LIVE_TRADING=false

# Drop root privileges
USER node

CMD ["node", "packages/orchestrator/dist/index.js"]
