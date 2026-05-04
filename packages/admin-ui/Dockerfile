# syntax=docker/dockerfile:1
#
# AgentWorks OS — admin-ui Dockerfile
# Multi-stage: pnpm install + Next.js build, then runtime serves the
# standalone output on PORT (default 3000).
#
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/admin-ui/package.json ./packages/admin-ui/package.json

RUN pnpm install --frozen-lockfile --prod=false

COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/admin-ui ./packages/admin-ui

RUN pnpm --filter @agentworks/shared build \
 && pnpm --filter admin-ui build

# next.js's COPY ./public step in the runtime stage requires the directory
# to exist, but admin-ui doesn't ship any static assets yet — ensure the
# directory exists so the multi-stage COPY does not fail on a fresh tree.
RUN mkdir -p /app/packages/admin-ui/public

# ------------------------------------------------------------------------------
# Runtime image
# ------------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/packages/admin-ui/.next ./.next
COPY --from=builder /app/packages/admin-ui/public ./public
COPY --from=builder /app/packages/admin-ui/package.json ./package.json
COPY --from=builder /app/packages/admin-ui/next.config.js ./next.config.js
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

CMD ["node_modules/.bin/next", "start", "-p", "3000"]
