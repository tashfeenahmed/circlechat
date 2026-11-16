# SPDX-License-Identifier: AGPL-3.0-only
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 libxcb1 libdbus-1-3 git \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false GOOSE_BIN_DIR=/usr/local/bin bash
LABEL circlechat.engine="goose"
ENV HOME=/home/agent
WORKDIR /home/agent/work
CMD ["goose", "acp"]
