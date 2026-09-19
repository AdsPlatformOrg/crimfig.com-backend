# Multi-stage Dockerfile for CrimFig Auth API on Railway
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy monorepo manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY shared/package.json ./shared/
COPY database/package.json ./database/
COPY auth/package.json ./auth/
COPY audit/package.json ./audit/
COPY api/ads-api/package.json ./api/ads-api/
COPY api/billing-api/package.json ./api/billing-api/
COPY api/chat-api/package.json ./api/chat-api/
COPY api/notifications-api/package.json ./api/notifications-api/
COPY api/reels-api/package.json ./api/reels-api/
COPY api/stream-api/package.json ./api/stream-api/

# Install dependencies
RUN pnpm install --no-frozen-lockfile

# Copy source trees
COPY shared ./shared
COPY database ./database
COPY auth ./auth

# Build packages in dependency order
RUN pnpm --filter @crimfig/shared build
RUN pnpm --filter @crimfig/database build
RUN pnpm --filter @crimfig/auth-api build

# Runner stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy compiled artifacts, workspace packages, schemas and migrations
COPY --from=builder /app ./

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4000/api/health || exit 1

# Execute Drizzle migrations before starting service
CMD ["sh", "-c", "pnpm --filter @crimfig/database db:migrate && node auth/dist/auth/src/main.js"]
