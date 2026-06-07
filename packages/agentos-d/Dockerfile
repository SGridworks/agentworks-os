# syntax=docker/dockerfile:1
#
# AgentWorks OS — agentos-d Dockerfile
# Multi-stage: build TypeScript, then run as lightweight Node runtime image.
#
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/policy-engine/package.json ./packages/policy-engine/package.json
COPY packages/memory/package.json ./packages/memory/package.json
COPY packages/pdf/package.json ./packages/pdf/package.json
COPY packages/agentos-d/package.json ./packages/agentos-d/package.json

RUN pnpm install --frozen-lockfile --prod=false

COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/policy-engine/src ./packages/policy-engine/src
COPY packages/policy-engine/tsconfig.json ./packages/policy-engine/tsconfig.json
COPY packages/memory/src ./packages/memory/src
COPY packages/memory/tsconfig.json ./packages/memory/tsconfig.json
COPY packages/pdf/src ./packages/pdf/src
COPY packages/pdf/tsconfig.json ./packages/pdf/tsconfig.json
COPY packages/agentos-d/src ./packages/agentos-d/src
COPY packages/agentos-d/tsconfig.json ./packages/agentos-d/tsconfig.json

RUN pnpm --filter @agentworks/shared build \
 && pnpm --filter @agentworks/policy-engine build \
 && pnpm --filter @agentworks/memory build \
 && pnpm --filter @agentworks/pdf build \
 && pnpm --filter @agentworks/agentos-d build

# ------------------------------------------------------------------------------
# Runtime image
# ------------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache curl && rm -rf /var/cache/apk/*

COPY --from=builder /app/packages/agentos-d/dist ./dist
COPY --from=builder /app/packages/agentos-d/node_modules ./node_modules
COPY --from=builder /app/packages/policy-engine/dist ./node_modules/@agentworks/policy-engine/dist
COPY --from=builder /app/packages/policy-engine/package.json ./node_modules/@agentworks/policy-engine/package.json
COPY --from=builder /app/packages/shared/dist ./node_modules/@agentworks/shared/dist
COPY --from=builder /app/packages/shared/package.json ./node_modules/@agentworks/shared/package.json
COPY --from=builder /app/packages/memory/dist ./node_modules/@agentworks/memory/dist
COPY --from=builder /app/packages/memory/package.json ./node_modules/@agentworks/memory/package.json
COPY --from=builder /app/packages/pdf/dist ./node_modules/@agentworks/pdf/dist
COPY --from=builder /app/packages/pdf/package.json ./node_modules/@agentworks/pdf/package.json

# Bundle rule packs into the image so policy.check works out of the box.
# Customers can override with RULE_PACKS_DIR pointing at a host volume.
COPY rule-packs /opt/agentworks/rule-packs

COPY --from=builder /app/packages/agentos-d/package.json ./package.json

ENV NODE_ENV=production \
    AGENTOS_HOST=0.0.0.0 \
    AGENTOS_PORT=7710 \
    RULE_PACKS_DIR=/opt/agentworks/rule-packs \
    VAULT_ROOT=/data/vault

EXPOSE 7710

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://127.0.0.1:${AGENTOS_PORT}/api/health || exit 1

ENTRYPOINT ["node", "dist/cli.js"]
