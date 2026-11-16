# Development

This page is for people who change CircleChat itself. It covers the repo layout, the scripts, the test engine, how to write tests, and the code style. Read [Contributing](../CONTRIBUTING.md) before you open a pull request.

## Requirements

- Node.js 24 or later. The server runs `.ts` files directly with Node's type stripping. There is no build step for the server.
- Docker, for real engines. The test suite does not need it.
- Chrome, for the browser tests and screenshots.

## Repo layout

```text
server/src/          the server (TypeScript, run directly by Node)
  index.ts           entry point, environment variables
  app.ts             wires the parts together
  server.ts          HTTP routing, websocket, the agent listener
  api.ts             JSON API
  services.ts        chats, routing, deliveries, memory, tasks, approvals, budgets
  gateway.ts         tool gateway: core tools, apps, MCP proxy, grants, policies
  apps.ts            app catalog presets
  toollog.ts         hash-chained tool log and redaction
  triggers.ts        webhooks and schedules
  hosting.ts         proxy trust, seed file, export, erase, hosted sign-in
  importer.ts        OpenClaw and Hermes import
  cli.ts             operator commands
  crypto.ts          passwords, vault, HMAC
  db.ts              SQLite schema and helpers
  bus.ts             in-process event bus
  agents/runtime.ts  agent supervisor, sessions, turns
  agents/acp.ts      ACP client
  agents/engines.ts  engine definitions
  bridges/slack.ts   Slack bridge
web/                 React + Vite web app (web/src/screens for each screen)
desktop/             Electron shell
engines/<id>/        one Dockerfile per engine
test/                unit and integration tests, test helpers
test/real/           real engine smoke tests (cost model calls)
e2e/                 browser tests
tools/               test engine, test MCP server, screenshot script
docs/                these pages and the README screenshots
```

## Scripts

| Command | What it does |
|---|---|
| `npm install` | Installs all workspaces (`server`, `web`, `desktop`). |
| `npm run build` | Builds the web app into `web/dist`. The server serves it. |
| `npm start` | Starts the server on port 3100. |
| `npm run dev` | Starts the server with `--watch` and the Vite dev server on port 5173. |
| `npm test` | Unit and integration tests. No Docker or network needed. |
| `npm run typecheck` | `tsc` for the server and the web app. |
| `npm run test:e2e` | Builds the web app, then runs the browser tests in Chrome. |
| `npm run test:engines -- <engines>` | Real engine smoke tests. See below. |
| `npm run desktop` | Starts the desktop app. |
| `node tools/screenshots.ts [outDir]` | Retakes the README screenshots. Run `npm run build` first. |

CI runs `tsc -p server`, `npm test`, `tsc -p web` and `npm run build` on every push and pull request.

### Hot reload for the web app

The Vite dev server proxies `/api`, `/ws`, `/mcp` and `/hooks` to `127.0.0.1:3150`, and `npm run dev` starts the server on that port:

```bash
npm run dev
# open http://localhost:5173
```

Use a separate data folder for development if you also run CircleChat for real: `CIRCLECHAT_DATA=/tmp/cc-dev`.

## The test engine

`tools/mock-agent.ts` is a deterministic agent that speaks real ACP over stdio and real MCP to the gateway. It is the `mock` engine (`mock-gw` is the same with tools wired at launch, like OpenClaw). It is hidden in Settings, Engines but accepted by the API, so you can use it to try the app without a model:

```bash
curl -X POST localhost:3100/api/agents -H 'content-type: application/json' -b 'cc_session=...' \
  -d '{"name": "Pip", "engine": "mock", "sandbox": "local"}'
```

It reacts to directives in the message:

| Message | What it does |
|---|---|
| `!tool <name> <json>` | Calls a gateway tool and reports the result. |
| `!permission` | Sends an ACP permission request. |
| `!slow <ms>` | Takes that long, sending progress updates. |
| `!crash` | Exits with code 1 in the middle of the turn. |
| `!usage <cents>` | Reports a usage update with that cost. |
| `!say <text>` | Replies with exactly that text. |
| `!silent` | Ends the turn without a reply. |
| anything else | Replies `<name> got: <message>`. |

`tools/test-mcp-server.ts` is a stdio MCP server with `echo` and `add` tools. If the file named in `EXTRA_TOOL_FILE` exists, it adds an `export_csv` tool, to test that new tools arrive switched off.

## Writing tests

Tests use `node:test` and `node:assert/strict`, and run one file at a time (`--test-concurrency=1`).

| File | What it covers |
|---|---|
| `test/unit.test.ts` | Pure functions: crypto, tool log chain, redaction, cron, filters, mentions, importer, app catalog, login limiter. |
| `test/integration.test.ts` | The real HTTP API, real ACP processes (the test engine), the real gateway, a real stdio MCP server and fake upstreams. |
| `test/hosting.test.ts` | Proxy trust, seed file, export, delete, the agent listener, the CLI, hosted sign-in. |
| `e2e/ui.e2e.ts` | The built web app in headless Chrome. |
| `test/real/real-engines.ts` | Real engines against a real model. |

`test/helpers.ts` gives you:

| Helper | What it does |
|---|---|
| `startApp(opts)` | A real `App` and HTTP server on a random port with a temporary data folder. Idle sleep is off by default. Call `close()` at the end. |
| `setupOwner(h)` | Creates the owner and returns a signed-in `Client`. |
| `Client` | A cookie-aware JSON client: `get`, `post`, `put`, `patch`, `del`. |
| `mockAgent(c, handle, extra?)` | Adds a test engine agent. |
| `agentReply(c, chatId, agentId, after)` | Waits for the agent's next reply in a chat. |
| `waitFor(fn, what, timeoutMs?)` | Polls until `fn` returns a truthy value. |
| `fakeServer(handler)` | A small HTTP server that records calls, to stand in for GitHub, an API or Slack. |

A typical test:

```ts
test("a DM gets an answer", async () => {
  const chat = (await c.post("/api/chats", { dmAgent: pip.id })).json.chat;
  const m = (await c.post(`/api/chats/${chat.id}/messages`, { body: "hello" })).json.message;
  const reply = await agentReply(c, chat.id, pip.id, m.ts);
  assert.equal(reply.body, "pip got: hello");
});
```

Rules for tests:

- Anything that touches the gateway, the vault or the sandbox needs a test that proves it stays closed by default.
- Use the test engine and fake servers, not real services, in `npm test`.
- Clean up with `h.close()`.

### Browser tests

```bash
npm run test:e2e
CHROME_PATH=/usr/bin/google-chrome npm run test:e2e   # Chrome somewhere else
```

### Real engine tests

These start real engines against a real model and cost model calls. They are not part of `npm test`.

```bash
LOCAL_MODEL_URL=http://localhost:11434/v1 LOCAL_MODEL=qwen3 \
  node test/real/real-engines.ts claude opencode hermes openclaw
```

| Variable | Meaning |
|---|---|
| `LOCAL_MODEL_URL` | An OpenAI-compatible endpoint. Set it: the default is a private address. |
| `LOCAL_MODEL` | The model name. |
| `SANDBOX` | `docker` or `local` for Claude Code and opencode. Hermes and OpenClaw always use Docker. |

Claude Code uses your own Claude Code login with the `local` sandbox. Each engine is checked for: a reply in chat, use of CircleChat tools through the gateway, and memory within a session. Results print as JSON lines.

## Code style

- **Plain TypeScript that Node can run directly.** Use only syntax that type stripping can remove: no `enum`, no `namespace`, no constructor parameter properties. Import local files with the `.ts` extension.
- **No build step for the server**, and few dependencies. The database is `node:sqlite`, so there are no native modules.
- **Formatting** with Prettier: `.prettierrc.json` sets a print width of 160, double quotes and trailing commas.
- **A licence header** on every source file: `// SPDX-License-Identifier: AGPL-3.0-only`.
- **UI copy**: plain words, short sentences, say "agent", no em dashes. Use commas, colons or full stops instead.
- **Secrets**: never log or return them. Store them with `gateway.putSecret` and return only a flag such as `hasSecret`.
- **Closed by default**: new resources start with no grants. New tool kinds should default to Ask or Block.
- **No automatic retries** of agent turns. A turn may already have had side effects.
