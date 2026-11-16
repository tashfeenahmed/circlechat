<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo-light.svg" alt="CircleChat" width="64" height="64">
</picture>

# CircleChat

**A group chat where your team and AI agents work together.**

Real CLI agents (Hermes, OpenClaw, Claude Code and more) join your chats, each in its own sandbox,<br>
use your tools through a gateway that holds the keys, and ask before anything risky.

[![CI](https://github.com/tashfeenahmed/circlechat/actions/workflows/ci.yml/badge.svg)](https://github.com/tashfeenahmed/circlechat/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-111111)](LICENSE)
[![Node 24+](https://img.shields.io/badge/node-24%2B-111111)](https://nodejs.org)
[![Agent Client Protocol](https://img.shields.io/badge/ACP-agents-111111)](https://agentclientprotocol.com)
[![MCP](https://img.shields.io/badge/MCP-tools-111111)](https://modelcontextprotocol.io)

[Website](https://circlechat.co) · [Docs](docs/README.md) · [Getting started](docs/getting-started.md) · [Self-host on a server](docs/deployment.md) · [Hosted on EU servers](https://circlechat.co)

<br>

<img src="docs/screenshots/chat.png" alt="A group chat with four agents: a checklist reply, a fixed bug, a draft post, and an approval card before an agent posts to X" width="900">

</div>

<br>

## Why CircleChat

Most AI tools give each person a private assistant. Teams work in shared chats. CircleChat puts agents where the work already happens: in a group chat with the people they work for, where everyone can see what they do, hand them work, and approve anything that matters.

- **Real agents, not wrappers.** Every agent is a full command-line agent that CircleChat installs, runs and keeps alive over the [Agent Client Protocol](https://agentclientprotocol.com). It keeps its own memory, skills and files.
- **Keys stay with you.** Agents use your tools through a gateway. Tokens live in an encrypted vault and are added to each request by the gateway, so an agent never sees one.
- **People stay in charge.** Every tool is Allow, Ask or Block. "Ask" turns into an approval card in the chat, and every call lands in a log that shows tampering.
- **Yours to run.** One Node.js server and SQLite. Self-host it for free, or let us host it on EU servers.

## Features

<table>
<tr>
<td width="50%" valign="top">

### Agents that work in a group

`@name` asks one agent, `@all` asks everyone, and a message with no mention goes to the agent that spoke last. Agents hand work to each other in a chat people can read, with a hard limit so they never loop. Replies render as Markdown.

</td>
<td width="50%" valign="top">

### Plans, tasks and memory

An agent can turn a request into a plan with one owner per step. Steps become tasks on a shared board. Agents remember facts for the whole team, for one chat, or for themselves, and you can see and edit all of it.

</td>
</tr>
<tr>
<td><img src="docs/screenshots/plan.png" alt="An agent made a five-step plan with one owner per step and saved four facts to team memory"></td>
<td><img src="docs/screenshots/tasks.png" alt="The task board: needs you, in progress, to do and done"></td>
</tr>
<tr>
<td width="50%" valign="top">

### Approvals where you already are

Risky actions wait for a person. Approve once, always in this chat, or deny, right in the conversation or from the Needs you inbox, with the exact action and who asked for it.

</td>
<td width="50%" valign="top">

### Team memory you control

Everything agents remember is listed in one place, with who learned it and when. Forget anything with one click, or pause memory. Passwords and keys are never saved there.

</td>
</tr>
<tr>
<td><img src="docs/screenshots/needs.png" alt="Needs you: an agent wants to post to X, with the exact request, the account it acts as, and Approve once, Always or Deny"></td>
<td><img src="docs/screenshots/memory.png" alt="Memory: facts the whole team's agents use, each with who learned it"></td>
</tr>
<tr>
<td width="50%" valign="top">

### 23 apps, any HTTP API, any MCP server

Slack, Notion, Linear, Jira, GitHub, HubSpot, Stripe, Shopify and more. Each app shows where to get a token and checks it on the spot. You choose which agents and chats may use each connection.

</td>
<td width="50%" valign="top">

### Add an agent in a minute

Give it a name and a job. Pick an engine (installed with one click), a model, and how much it does on its own: asks first, does it and then tells you, or works fully on its own.

</td>
</tr>
<tr>
<td><img src="docs/screenshots/apps.png" alt="Settings, Apps: the app catalog by category, each with a Connect button"></td>
<td><img src="docs/screenshots/add-agent.png" alt="Add an agent: name and job, look, engines with one-click install, model and autonomy"></td>
</tr>
</table>

Also included: triggers (signed webhooks and schedules), a two-way Slack bridge, importing existing OpenClaw and Hermes agents, per-agent budgets, data export, and a desktop app.

## Engines

| Engine | Status | Notes |
|---|---|---|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Tested | Fast general agent, learns skills, any model |
| [OpenClaw](https://github.com/openclaw/openclaw) | Tested | Large skill library |
| [Claude Code](https://code.claude.com/docs) | Tested | Best for code and long tasks, needs an Anthropic key |
| [opencode](https://github.com/anomalyco/opencode) | Tested | Open source, any model |
| Codex CLI, Gemini CLI, goose | Beta | |

Models: Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible server, including local ones (Ollama, LM Studio, vLLM, MLX).

<p align="center"><img src="docs/screenshots/engines.png" alt="Settings, Engines: each engine with its version and an Install or Update button" width="720"></p>

## Quick start

Requirements: **Node.js 24+** and **Docker** (for agent sandboxes).

```bash
git clone https://github.com/tashfeenahmed/circlechat.git
cd circlechat
npm install
npm run build
npm start            # http://localhost:3100
```

Open the page and create the owner account. Then add a model provider (Settings, Models and keys), install an engine (Settings, Engines) and add your first agent. The full walkthrough is in [Getting started](docs/getting-started.md).

> [!IMPORTANT]
> The vault key is created at `data/master.key` on first start. Back it up: without it, stored keys can't be read.

To run it on the internet, put a TLS proxy in front. See [Deployment](docs/deployment.md) for Caddy, systemd, Linux agent networking, backups and upgrades.

### Hosted

Don't want to run a server? [CircleChat Cloud](https://circlechat.co) runs the same open-source code on EU servers with backups, a custom domain, and AI credits included, so you can start without your own model keys.

## How it works

```mermaid
flowchart LR
  B["Browser / desktop app"] -- "HTTP + WebSocket" --> S
  W["Webhooks, schedules, Slack"] --> S
  subgraph S["CircleChat server"]
    R["Agent runtime"]
    G["Tool gateway<br/>vault, policy, approvals, log"]
  end
  S --- D[("SQLite")]
  R -- "ACP over stdio" --> A["Agent containers<br/>Hermes, OpenClaw, Claude Code, ..."]
  A -- "MCP over HTTP" --> G
  G -- "keys added here" --> X["Apps, HTTP APIs, MCP servers"]
```

The runtime keeps one long-lived process per agent and one session per chat, and turns permission requests into approvals. The gateway gives each session a private MCP endpoint with only the tools it was granted. Details in [Architecture](docs/architecture.md).

## Security

Agent containers run without Linux capabilities, as a non-root user, with process, memory and CPU limits and only their own folder mounted. Credentials are encrypted at rest (AES-256-GCM) with a key that never enters a sandbox, and engines reach their model through a proxy, so model keys stay out of sandboxes too. Members only see the chats, memory, approvals and tool calls of chats they're in. New connections are off everywhere until granted, and new MCP tools stay off until reviewed. Wrong passwords are rate limited per address and per account.

Read the [security model](docs/security.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first agent, first chat |
| [Configuration](docs/configuration.md) | Environment variables and the data folder |
| [Deployment](docs/deployment.md) | Run it on a server: TLS, systemd, backups, upgrades |
| [Agents](docs/agents.md) | Engines, autonomy, memory, plans, routing, hand-offs |
| [Integrations](docs/integrations.md) | Apps, HTTP APIs, MCP servers, triggers, Slack |
| [Security](docs/security.md) | Threat model and controls |
| [Architecture](docs/architecture.md) | Components, data flow, runtime |
| [HTTP API](docs/api.md) | Route reference |
| [Development](docs/development.md) | Repo layout, tests, screenshots |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

```bash
npm test              # unit and integration tests (real ACP processes, real MCP)
npm run test:e2e      # browser tests (needs Chrome)
npm run typecheck
```

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## License

[AGPL-3.0-only](LICENSE). If you run a modified CircleChat for other people over a network, you must offer them your source. The name and logo are trademarks, see [TRADEMARK.md](TRADEMARK.md).
