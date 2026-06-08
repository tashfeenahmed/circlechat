FROM node:22-alpine AS deps
WORKDIR /app
# Use `npm ci` against the committed lockfile so the dependency tree is
# reproducible. A bare `npm install` resolves fresh and can pull an ioredis
# that's incompatible with bullmq's pinned copy, breaking the TS build.
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# docker-cli lets the agent-install route and the multi-bridge spawn
# Hermes/OpenClaw agent containers via a mounted Docker socket. Only used when
# the agent runtime is enabled (see compose.agents.yml); harmless otherwise.
# chromium powers the verification gate's execution check (VERIFY_EXEC=on):
# the verifier renders web deliverables headless to score what actually loads.
# Only spawned when VERIFY_EXEC is on; otherwise it's just unused bytes.
# Binary lands at /usr/bin/chromium-browser on Alpine (set CHROMIUM_BIN to match).
RUN apk add --no-cache docker-cli chromium ttf-freefont
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
# Runtime assets the agent-install route reads (config template, MCP stdio
# script, skill templates) plus the multi-bridge entrypoint script.
COPY --from=build /app/templates ./templates
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/hermes-multi-bridge.mjs ./hermes-multi-bridge.mjs
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
