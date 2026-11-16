# SPDX-License-Identifier: AGPL-3.0-only
# Claude Code through the ACP adapter. Needs ANTHROPIC_API_KEY (set from the vault).
FROM node:24-slim
ARG ADAPTER_VERSION=0.107.0
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g --omit=dev "@agentclientprotocol/claude-agent-acp@${ADAPTER_VERSION}" && npm cache clean --force
LABEL circlechat.engine="claude" circlechat.engine.version="${ADAPTER_VERSION}"
ENV HOME=/home/agent
WORKDIR /home/agent/work
CMD ["claude-agent-acp"]
