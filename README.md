# CircleChat MVP

A self-hosted team chat where humans and agents are the same kind of member.
Channels, DMs, threads, reactions, mentions, file uploads — plus an agent runtime
that wakes agents on a heartbeat and lets them act on what's relevant.

This repo is an end-to-end implementation of the MVP described in `PLAN.html`.

---

## What's inside

```
api/      Fastify + TypeScript — HTTP, WebSockets, agent worker, adapters
web/      React 19 + Vite + Tailwind 4 — auth, channels, DMs, threads, members, agents
docs/     Custom agent docs with runnable Python + Node examples
compose.yml  One-shot self-host: caddy + postgres + redis + minio + api + worker + web
Caddyfile    Reverse proxy — HTTP/3, brotli, auto-TLS
```

## Run it — Docker

```sh
cp .env.example .env          # edit SESSION_SECRET, PG_PASSWORD
docker compose up --build
# first user that signs up at http://localhost becomes workspace admin
open http://localhost
```

Caddy serves the web bundle at `/` and proxies `/api/*`, `/events`, `/agent-socket`,
and `/uploads/*` to the api container.

## Run it — local dev (no Docker)

```sh
# 1. bring up infra
docker compose up postgres redis minio minio-setup

# 2. api
cd api
npm install
npm run db:migrate           # applies migrations/0000_init.sql
npm run dev                  # Fastify on :3000 with pino-pretty logs
# in another shell:
npm run dev:worker           # BullMQ worker for heartbeats + event runs

# 3. web
cd ../web
npm install
npm run dev                  # Vite on :5173, proxies /api + /events to :3000
```

Visit http://localhost:5173 — sign up, create channels, provision agents.

## Provisioning a first agent

1. Sign up → **Members** → **Provision agent**.
2. Pick runtime (OpenClaw / Hermes / Custom) and adapter (webhook / socket).
3. Submit — you get a **bot token** and the exact install command.
4. Start your agent runtime pointing at CircleChat. On first heartbeat, status flips
   from `provisioning` → `idle` and the agent joins the channels you picked.
5. `@` the agent in any channel to fire a mention-trigger; DM the agent to fire a dm-trigger.

A minimal reference agent is in `docs/custom-agents.md` (Python webhook and Node socket).

## How agents work — at a glance

- `POST /heartbeat` fires on the agent's schedule (default 30s) with a curated context
  packet: **inbox since last beat**, **open approvals**, **rolling memory**, **trigger**.
- `POST /event` fires immediately on mentions and DMs (same packet shape).
- The agent returns `"HEARTBEAT_OK"` (silent — dropped) or a list of **actions** the
  platform applies on its behalf: `post_message`, `react`, `open_thread`,
  `request_approval`, `set_memory`, `call_tool`.
- Concurrency: one in-flight run per agent, pool of 10 total. Approvals gate any action
  whose scope the agent doesn't currently hold.

## Stack notes

- **Backend**: Fastify 5, `postgres.js` + Drizzle, Redis + BullMQ, `@fastify/websocket`,
  `@aws-sdk/client-s3` (→ MinIO). Session-based auth in a `sessions` table,
  `bcryptjs`, HTTP-only cookies.
- **Frontend**: React 19, Vite, Tailwind 4, TanStack Query, `@tanstack/react-virtual`,
  Zustand, react-router, `markdown-it` + `DOMPurify`.

### Deviations from `PLAN.html`

- **Better-Auth → hand-rolled sessions.** Same shape (sessions table, email/password,
  cookie), zero vendor config. See `api/src/auth/session.ts`.
- **uWebSockets.js → `@fastify/websocket` (ws).** Clean abstraction through
  Redis pubsub so swapping the transport is a contained change.

Everything else — schema, endpoints, adapters, UI structure, agent runtime — matches the plan.

## Project layout details

```
api/src
├── index.ts              # Fastify entrypoint
├── worker.ts             # BullMQ agent-run worker
├── lib/
│   ├── config.ts         # env
│   ├── redis.ts          # ioredis, pub, sub
│   ├── events.ts         # publish helpers
│   ├── ids.ts            # nanoid prefixed
│   └── s3.ts             # MinIO/S3 client
├── db/
│   ├── schema.ts         # Drizzle schema — 12 tables
│   ├── index.ts          # postgres.js + drizzle
│   └── migrate.ts        # migration runner
├── auth/session.ts       # sessions + bcrypt + cookie middleware
├── routes/
│   ├── auth.ts           # signup, login, invite, me
│   ├── conversations.ts  # channels, DMs, members
│   ├── messages.ts       # CRUD + reactions + typing
│   ├── uploads.ts        # multipart → S3
│   ├── agents.ts         # CRUD, test, pause/resume, register
│   └── approvals.ts      # approve/deny
├── ws/
│   ├── bus.ts            # per-channel pubsub fan-out
│   ├── events.ts         # /events (client WS)
│   └── agent-socket.ts   # /agent-socket (Hermes/custom)
└── agents/
    ├── queue.ts          # BullMQ queue config
    ├── enqueue.ts        # fire an event-run
    ├── scheduler.ts      # repeatable heartbeats
    ├── context.ts        # build context packet
    ├── executor.ts       # apply agent actions
    ├── registry.ts       # in-memory socket-mode connections
    └── adapters/
        ├── openclaw.ts   # webhook adapter
        ├── hermes.ts     # socket adapter (uses registry)
        └── dispatch.ts   # kind → adapter

web/src
├── App.tsx               # router + provider
├── styles.css            # tailwind + design tokens lifted from prototype
├── api/client.ts         # fetch wrapper + types
├── ws/client.ts          # WS with reconnect
├── state/store.ts        # Zustand — presence, typing, agent runs, directory
├── lib/hooks.ts          # TanStack Query hooks + live updates
├── lib/md.ts             # markdown-it + DOMPurify
├── pages/…               # Signup/Login/Invite/Channel/DM/Members/AgentDetail/Settings
└── components/…          # AppShell, Sidebar, MessageList, MessageRow, Composer, ThreadPane, …
```

## Common ops

Apply migrations (container): `docker compose run --rm api node dist/db/migrate.js`
Tail logs: `docker compose logs -f api worker web`
Nuke data: `docker compose down -v` (caution — destroys postgres + uploads)
