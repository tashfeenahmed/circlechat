# SPDX-License-Identifier: AGPL-3.0-only
# Hermes Agent (Nous Research, MIT) speaking ACP on stdio, built on the official image.
ARG HERMES_VERSION=v0.23.1
FROM nousresearch/hermes-agent:${HERMES_VERSION}
ARG HERMES_VERSION=v0.23.1
ENTRYPOINT []
COPY cc-hermes-acp /usr/local/bin/cc-hermes-acp
RUN chmod 755 /usr/local/bin/cc-hermes-acp && mkdir -p /var/lib/hermes && chmod 1777 /var/lib/hermes
ENV HOME=/home/agent HERMES_HOME=/var/lib/hermes/home HERMES_WRITE_SAFE_ROOT=/home/agent XDG_RUNTIME_DIR=/tmp/hermes-runtime
LABEL circlechat.engine="hermes" circlechat.engine.version="${HERMES_VERSION}"
WORKDIR /home/agent/work
CMD ["cc-hermes-acp"]
