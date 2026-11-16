# SPDX-License-Identifier: AGPL-3.0-only
# OpenClaw (MIT). Its ACP mode is a bridge to a local OpenClaw Gateway, so the
# launcher starts a private gateway inside the sandbox first.
FROM node:24-slim
ARG OPENCLAW_VERSION=2026.11.3
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g --omit=dev "openclaw@${OPENCLAW_VERSION}" && npm cache clean --force
COPY cc-openclaw-acp /usr/local/bin/cc-openclaw-acp
RUN chmod 755 /usr/local/bin/cc-openclaw-acp
LABEL circlechat.engine="openclaw" circlechat.engine.version="${OPENCLAW_VERSION}"
ENV HOME=/home/agent
WORKDIR /home/agent/work
CMD ["cc-openclaw-acp"]
