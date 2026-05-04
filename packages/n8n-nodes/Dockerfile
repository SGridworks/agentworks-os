FROM n8nio/n8n:1.68.0

USER root

# Install AgentWorks custom nodes into n8n's node_modules.
# n8n auto-discovers nodes by scanning for packages with an "n8n" field in their
# package.json. This is the same mechanism npm-installed community packages use.
WORKDIR /home/node/.n8n

# Copy the pre-built package: dist/ + package.json (renamed to agentworks-nodes-package.json in-container)
COPY --chown=node:node ./packages/n8n-nodes/dist /tmp/agentworks-nodes/dist
COPY --chown=node:node ./packages/n8n-nodes/package.json /tmp/agentworks-nodes/agentworks-nodes-package.json

# Install into @agentworks/n8n-nodes so n8n discovers it
RUN mkdir -p node_modules/@agentworks/n8n-nodes && \
    cp /tmp/agentworks-nodes/agentworks-nodes-package.json node_modules/@agentworks/n8n-nodes/ && \
    cp -r /tmp/agentworks-nodes/dist/* node_modules/@agentworks/n8n-nodes/ && \
    chown -R node:node node_modules/@agentworks/

# Verify the package is loadable
RUN node --input-type=module <<'EOF'
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const p = require('/home/node/.n8n/node_modules/@agentworks/n8n-nodes/agentworks-nodes-package.json');
console.log('Package name:', p.name);
console.log('n8n nodes:', p.n8n?.nodes?.length, 'nodes configured');
EOF

USER node
