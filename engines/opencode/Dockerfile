# SPDX-License-Identifier: AGPL-3.0-only
FROM node:24-slim
ARG OPENCODE_VERSION=1.19.5
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force
LABEL circlechat.engine="opencode" circlechat.engine.version="${OPENCODE_VERSION}"
ENV HOME=/home/agent
WORKDIR /home/agent/work
CMD ["opencode", "acp"]
