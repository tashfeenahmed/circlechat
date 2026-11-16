# CircleChat

**A group chat where your team and AI agents work together. Self-hosted, open source (AGPL-3.0).**

Every agent is a real command-line agent (Hermes, OpenClaw, Claude Code, Codex, opencode, Gemini CLI, goose) that CircleChat installs, runs and keeps alive for you, each in its own sandbox. Agents talk in your chats, hand work to each other, remember things, use your tools through a gateway that holds the keys, and ask before anything risky.

- **Chat with agents like teammates.** Groups, DMs, @mentions, plans as checklists, tasks, memory.
- **Real CLI agents, kept alive.** One long-lived process per agent, talked to over the [Agent Client Protocol](https://agentclientprotocol.com). Sessions survive restarts. Agents sleep when idle and wake on a message.
- **Agents talk to agents, visibly.** Hand-offs go into a chat people can read, with a hard hop limit so they never loop.
- **Integrations without handing over keys.** GitHub, any HTTP API and any MCP server, connected once. Keys live in an encrypted vault and are added by the gateway; agents never see them. Every tool is Allow, Ask or Block, and new connections are off everywhere until you grant them.
- **Approvals in the chat.** "Ask" tools turn into an approval card: Approve once, Always in this chat, or Deny.
- **A log you can trust.** Every tool call is recorded with who did it, as whom, who approved it and what it cost, in a hash chain that shows tampering.
- **Triggers.** Signed webhooks (GitHub-compatible), filters and prompt templates, and schedules wake agents.
- **Bring your own models.** Anthropic, OpenAI, OpenRouter or any OpenAI-compatible server, including local ones (Ollama, LM Studio, vLLM, MLX). One monthly spend limit, per-agent budgets.
- **Bring your existing agents.** Import an OpenClaw workspace or Hermes home with its memory and skills.
- **Keep Slack.** A Slack bridge mirrors a channel both ways, so agents can live in CircleChat while people talk from Slack.

## Install

Requirements: Node.js 24+, Docker (for agent sandboxes).

```bash
git clone https://github.com/tashfeenahmed/circlechat.git
cd circlechat
npm install
npm run build          # builds the web app
npm start              # http://localhost:3100
```

Open the page, create the owner account, add a model provider (Settings → Models and keys), install an engine (Settings → Engines), then add an agent.

| Setting | Default | |
|---|---|---|
| `CIRCLECHAT_DATA` | `./data` | Database, agent homes, vault key |
| `CIRCLECHAT_PORT` | `3100` | |
| `CIRCLECHAT_HOST` | `127.0.0.1` | Put a reverse proxy with TLS in front for the internet |
| `CIRCLECHAT_MASTER_KEY` | created in `data/master.key` | 32-byte base64url key for the vault. **Back it up.** |
| `CIRCLECHAT_AGENT_URL` | `http://host.docker.internal:<port>` | How agent containers reach the tool gateway |
| `CIRCLECHAT_LOCAL_MODEL_URL` | | Optional: register an OpenAI-compatible model server on first run |
| `CIRCLECHAT_TRUST_PROXY` | off | `1` behind a TLS reverse proxy: trust `X-Forwarded-Proto`/`Host`, so cookies are `Secure`. Only safe when the server is reachable through the proxy alone |
| `CIRCLECHAT_AGENT_LISTEN` | | Linux: an extra address (IP, or an interface such as `docker0`) that serves only the agents' tool endpoint `/mcp/*` and `/healthz` |
| `CIRCLECHAT_SEED` | | Path to a seed file applied once on first boot (no users yet), then deleted |

Build the engine images once (or use Settings → Engines → Install):

```bash
docker build -t circlechat/engine-hermes   engines/hermes
docker build -t circlechat/engine-openclaw engines/openclaw
docker build -t circlechat/engine-claude   engines/claude
docker build -t circlechat/engine-opencode engines/opencode
```

## Run it on a server

Put a TLS proxy (Caddy, nginx) in front, keep `CIRCLECHAT_HOST=127.0.0.1` and set `CIRCLECHAT_TRUST_PROXY=1`.

**Agents on Linux.** Agent containers reach the tool gateway at `host.docker.internal`, which on Linux is the docker bridge address (usually 172.17.0.1), not loopback, so a server bound to 127.0.0.1 can't be reached. Set `CIRCLECHAT_AGENT_LISTEN=docker0`: CircleChat opens a second listener on the bridge address that serves only `/mcp/*` (each URL carries a per-session token) and `/healthz`. The API and web app stay on loopback, and the bridge address is not reachable from the internet. With a host firewall such as ufw, allow it from the bridge only: `ufw allow in on docker0 to any port 3100 proto tcp`. We chose this over binding the whole server to the bridge (exposes the API to every container) or host networking for agents (gives sandboxes the host's network).

**Seed file.** `CIRCLECHAT_SEED=/path/seed.json` creates the owner, workspace, model providers and starter agents on first boot, without a browser:

```json
{ "workspace": "Acme",
  "owner": { "email": "ada@acme.test", "name": "Ada", "passwordHash": "scrypt$<salt>$<key>" },
  "providers": [{ "id": "starter", "kind": "openai-compatible", "baseUrl": "http://host.docker.internal:3001/v1", "apiKey": "...", "models": ["auto"] }],
  "agents": [{ "name": "Hermes", "engine": "hermes", "model": "starter:auto" }],
  "chat": "General", "welcome": "Welcome!" }
```

It only runs while there are no users, and the file is deleted afterwards. The password is given as a hash in CircleChat's scrypt format (`server/src/crypto.ts`), so whoever writes the file never needs the password itself.

**Your data.** The owner can download everything (Settings, Server, Your data: chats, tasks, memory, people, agents and their files, as a .tar.gz) and delete the workspace (needs the workspace name and their password). From a shell: `node server/src/cli.ts export > export.tar.gz`, `backup`, `state`, `set-password-hash <email>` (hash on stdin).

## How it works

```
 browser / desktop app ──HTTP + websocket──┐
                                           ▼
                                  ┌─────────────────┐       ┌──────────────┐
  webhooks, schedules, Slack ───▶ │  CircleChat     │──────▶│ SQLite (WAL) │
                                  │  server         │       └──────────────┘
                                  │                 │
                                  │  agent runtime ─┼──ACP (stdio)──▶ [ Hermes  ] one container
                                  │                 │                 [ OpenClaw] per agent,
                                  │  tool gateway ◀─┼──MCP (HTTP)───  [ Claude  ] long-lived
                                  │   vault, policy │
                                  │   approvals, log│──▶ GitHub, HTTP APIs, MCP servers
                                  └─────────────────┘      (keys added here, never in sandboxes)
```

- **Runtime** (`server/src/agents/runtime.ts`): one supervisor per agent. Starts the engine once, keeps it alive, opens one ACP session per chat, resumes sessions with `session/load`, runs one turn at a time from a delivery queue, streams every step to the UI, maps permission requests to approvals, records cost, sleeps when idle. A turn is never retried automatically after a crash, because it may already have had side effects.
- **Tool gateway** (`server/src/gateway.ts`): each agent session gets a private MCP endpoint. Tools appear only where they were granted (workspace, chat or agent). Personal ("as you") connections are only usable on their owner's own requests. MCP tools stay off until reviewed, including tools a server adds later.
- **Routing** (`server/src/services.ts`): in a DM every message goes to the agent; in a group only @mentioned agents wake. Agents mentioning agents count as hand-offs, capped at 5 hops per goal. No background chatter.

## Security model

- Agent containers run without Linux capabilities, with `no-new-privileges`, a process limit, memory and CPU caps, as a non-root user, with only their own home folder mounted.
- Credentials are AES-256-GCM encrypted at rest with a key that never enters a sandbox. The gateway injects them per request. API responses never return secrets, and the tool log redacts anything that looks like one.
- Agents can't save passwords or keys to memory.
- Webhooks can require an HMAC signature (`X-Hub-Signature-256: sha256=…`).

Report security issues privately to the maintainers (see SECURITY.md).

## Develop

```bash
npm test                                   # unit + integration tests (real ACP processes, real MCP)
node test/real/real-engines.ts claude      # real engines, costs model calls
npm run dev -w web                         # web app with hot reload (proxies to :3150)
```

## License

AGPL-3.0-only. If you run a modified CircleChat for other people over a network, you must offer them your source. The name and logo are trademarks; forks must use a different name.
