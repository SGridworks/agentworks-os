FROM node:22-alpine AS builder

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/n8n-nodes/package.json packages/n8n-nodes/package.json
RUN pnpm install --frozen-lockfile --filter @agentworks/n8n-nodes...

COPY packages/n8n-nodes packages/n8n-nodes
RUN pnpm --filter @agentworks/n8n-nodes build

FROM n8nio/n8n:1.68.0

USER root

# Install AgentWorks custom nodes outside the persisted runtime state volume.
ENV N8N_CUSTOM_EXTENSIONS=/opt/agentworks/n8n-custom
WORKDIR /opt/agentworks/n8n-custom/@agentworks/n8n-nodes

COPY --from=builder --chown=node:node /workspace/packages/n8n-nodes/package.json ./package.json
COPY --from=builder --chown=node:node /workspace/packages/n8n-nodes/dist ./dist

RUN node --input-type=module -e "import fs from 'node:fs'; const p = JSON.parse(fs.readFileSync('./package.json','utf8')); const nodes = p.n8n?.nodes ?? []; if (nodes.length < 4) throw new Error('AgentWorks workflow nodes missing'); for (const node of nodes) fs.accessSync(node); console.log('AgentWorks workflow nodes:', nodes.length);"

USER node
