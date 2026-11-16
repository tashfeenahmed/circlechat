# SPDX-License-Identifier: AGPL-3.0-only
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex @zed-industries/codex-acp && npm cache clean --force
LABEL circlechat.engine="codex"
ENV HOME=/home/agent
WORKDIR /home/agent/work
CMD ["codex-acp"]
