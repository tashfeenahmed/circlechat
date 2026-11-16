# Security

CircleChat runs AI agents that can change things in the real world. This page explains what CircleChat protects against, the controls that do it, and what it does not protect. To report a problem, see [Reporting](#reporting-a-vulnerability).

## Threat model

CircleChat is built on the idea that an agent may misbehave. A model can make mistakes, and text it reads (a web page, an issue, an email) can try to steer it. So CircleChat does not rely on the agent's good behaviour. It limits what the agent can reach.

| We protect against | How |
|---|---|
| An agent using a tool, app or chat it was not given | Grants, per-session gateway tokens, chat membership |
| An agent doing something risky without a person | Ask policies, sandbox permission requests, autonomy levels |
| An agent seeing app keys | Vault, gateway injects keys per call |
| An agent damaging the host or other agents | Docker sandbox with least privilege, one home folder per agent |
| Agents keeping each other busy forever | 5-hop limit per goal |
| Someone guessing passwords | scrypt, per-address and per-account limits |
| Forged webhook calls | HMAC signatures |
| Quietly changing the record of what agents did | Hash-chained tool log |

| Trusted | Why |
|---|---|
| The server host, its operator and the Docker daemon | They hold the database, the vault key and the containers. |
| Owners and admins | They manage keys, people and settings. |
| Builders | They add agents, connections and MCP servers. A stdio MCP server and the agent import read from or run on the server (see below). |
| The model provider | The engine sends the conversation to it. |

## Agent sandboxes

Each agent with the `docker` sandbox runs in its own container (`server/src/agents/runtime.ts`):

| Control | Setting |
|---|---|
| No Linux capabilities | `--cap-drop ALL` |
| No privilege escalation | `--security-opt no-new-privileges` |
| Not root | `--user <server uid>:<gid>` |
| Bounded processes | `--pids-limit 512` |
| Memory and CPU caps | `--memory 2g` (OpenClaw `4g`), `--cpus 2` by default |
| Own files only | Only the agent's home folder is mounted, at `/home/agent` |
| Short-lived container | `--rm`; the container is removed when the process stops |

The ACP client in CircleChat offers no file system or terminal access to the engine. The engine works on files inside its own container.

## Vault

- App keys, MCP secrets, model provider keys, Slack bridge tokens and the hosting secret are encrypted with AES-256-GCM (`server/src/crypto.ts`) and stored in the `secrets` table.
- The vault key is `CIRCLECHAT_MASTER_KEY` or `data/master.key` (mode 600). It never enters a sandbox and is not part of backups or exports.
- API responses never return secret values, only flags such as `hasKey` and `hasSecret`.

## Tool gateway

The gateway (`server/src/gateway.ts`) is the only path from an agent to connected apps and MCP servers.

- **Per-session tokens.** Each agent session gets its own MCP URL with a random 24-byte token. Tokens live in memory only and are revoked when the session or process ends.
- **Off by default.** A new connection or MCP server has no grants, so no agent can use it until someone grants it to the workspace, a chat or an agent.
- **Policies.** Each tool is Allow, Ask or Block. Writes ask and dangerous calls are blocked by default.
- **MCP review.** MCP tools are off until reviewed, including tools a server adds later.
- **Keys added per call.** The gateway reads the key from the vault for each call. The agent sends only the path and body.
- **HTTP pinning.** HTTP connections only call their own host, don't follow redirects, and catalog apps check extra fields against strict patterns.
- **GitHub repo list.** A GitHub connection can be limited to named repos.
- **Personal connections** act "as you" only on your own requests, never on someone else's, a hand-off or a trigger.

## Approvals

Two things create an approval card:

- a gateway tool with the Ask policy
- a sandbox permission request from the engine that the agent's autonomy level doesn't allow on its own

The agent waits for an answer. No answer within 24 hours counts as no. Admins, the person who made the request, and members of the chat can answer. Every decision is written to the tool log.

## Secret handling

- Agents are told never to ask for, store or repeat passwords or keys.
- Memory refuses text that looks like a password or key (GitHub tokens, `sk-` keys, Slack tokens, AWS access keys, private keys, `password: ...`).
- The tool log replaces anything that looks like a credential with `[redacted]` before writing.
- Secrets must never be logged or returned by the API. This is a project rule for every change (see [Contributing](../CONTRIBUTING.md)).

## Accounts and sessions

| Control | Detail |
|---|---|
| Passwords | scrypt (N=16384, r=8, p=1, 16-byte salt). At least 8 characters. |
| Login limits | 20 wrong passwords per address and 10 per account in a sliding 15-minute window. Kept in memory, so a restart resets them. |
| Sessions | A random 32-byte token in an `httpOnly`, `SameSite=Lax` cookie, valid for 30 days. `Secure` when the request is HTTPS, or `X-Forwarded-Proto: https` with `CIRCLECHAT_TRUST_PROXY=1`. |
| Password change | Needs the current password. Signs out every other session. |
| Live updates | The websocket sends each person only events for chats they may see. |
| Hosted sign-in | On circlechat.co, the control plane's "Open workspace" button uses a one-time HMAC-signed token, valid for 2 minutes, for the owner only. |

## Network exposure

- The server binds `127.0.0.1` by default. Put a TLS proxy in front for the internet.
- `CIRCLECHAT_AGENT_LISTEN` opens a second listener that serves only `/mcp/*` and `/healthz`. See [Deployment](deployment.md#agents-on-linux).
- `/mcp/*` and `/hooks/*` request bodies are limited to 2 MB.

## Webhook signatures

When a webhook trigger has a secret, each call must carry `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`. The comparison is constant-time. Bad or missing signatures get a 401 and are recorded as rejected.

## Tool log

Every tool call is recorded with the agent, chat, tool, arguments, identity, approval, status, result and cost. Each entry's hash covers the previous entry's hash and its own fields, starting from a hash of zeros. Settings, Tool log, **Verify** recomputes the chain and names the first entry that doesn't match.

## Model keys

Engines never receive a model provider's key. When an agent starts, CircleChat gives its engine the address of CircleChat's model proxy (`/llm/<token>/v1` for OpenAI-compatible and OpenAI providers, `/llm/<token>/anthropic` for Anthropic) and a stand-in token made for that agent (`server/src/agents/modelproxy.ts`). The proxy swaps the token for the real key and forwards the request to the provider's own address only. The token stops working when the agent stops, so engine config files in an agent's home hold nothing worth stealing. The one exception is Gemini CLI, listed below.

On a Linux server the proxy is served on the same narrow agent listener as the tool gateway (`CIRCLECHAT_AGENT_LISTEN`).

## Agent network limits

`CIRCLECHAT_AGENT_EGRESS=none` or `allowlist` closes the network around agent containers (`server/src/agents/egress.ts`):

- Agent containers join a Docker network made with `--internal`, so they have no route out, and get `--dns 127.0.0.1`, so they can't look up outside names (nothing can leave inside a DNS query).
- The only way out is a small filter container (`egress/proxy.mjs`) on both networks. It lets through CircleChat's own address (the tool gateway and the model proxy) and, in `allowlist` mode, the listed hosts on ports 80 and 443. Everything else gets a 403 and a line in the filter's log (`docker logs cc-egress-...`).
- Agents get `HTTP_PROXY` and `HTTPS_PROXY` pointing at the filter. Software that ignores them can't connect at all, so the limit fails closed.
- Because model calls go through CircleChat's model proxy, `none` is enough for agents to think and use their tools. Add hosts only for what agents fetch themselves, such as `github.com` for git or `pypi.org` for packages.
- If the network can't be set up at start, agents in containers don't start. The log says why.

The `local` sandbox (development only) is not covered.

## Who can see and do what

| | Member | Builder | Admin |
|---|---|---|---|
| Chats, their memory, tasks, approvals, tool calls and agent activity | Chats they're in | Chats they're in | Everything |
| Pause, wake, restart an agent, start a new session | No | Yes | Yes |
| Cancel an agent's current turn | In a chat they're in | Yes | Yes |
| Test a connection, refresh an MCP server, see or replay trigger runs | Their own personal connections | Yes | Yes |
| Test a model provider, see Slack bridges | No | No | Yes |

## What is not protected

Be aware of these limits when you decide what to give an agent.

- **Gemini CLI gets its model key.** Every other engine calls its model through CircleChat's model proxy (see [Model keys](#model-keys)), but Gemini CLI only talks to Google, so it receives the key itself. Use a separate key with a spending limit for it.
- **An agent can spend through its model.** The proxy keeps the key out of the sandbox, not the model calls: while an agent runs, its stand-in token can make model calls. Per-agent budgets and the workspace limit cap that.
- **Agents have network access by default.** With `CIRCLECHAT_AGENT_EGRESS` unset, containers use Docker's default bridge network and can reach the internet and any service on the host or local network they can route to. Set it to `none` or `allowlist` (see [Agent network limits](#agent-network-limits)). The filter covers HTTP and HTTPS by host name; it does not inspect what an allowed host is sent.
- **The `local` sandbox is not a sandbox.** The agent runs as the server's user with the server's access. Use it for development only.
- **stdio MCP servers run on the host.** A builder who adds one runs that command on the server as the server's user. Only give the builder role to people you trust with the server.
- **Import reads server folders.** The import path is a folder on the server. A builder can read the agent files (`SOUL.md`, `MEMORY.md` and so on) from any folder the server can read.
- **The workspace is shared.** Agents-only chats, team memory and every agent's own notes are visible to every signed-in member. Chats, their memory, their tasks, their approvals, their tool calls and an agent's activity in them are limited to the chat's members (admins see everything). CircleChat is designed for one team, not for people who must be kept apart.
- **The tool log is tamper-evident, not tamper-proof.** The chain has no outside anchor or key. Someone who can write to the database can rewrite the whole chain so that it verifies. It also records gateway calls and permission decisions only; what an engine does inside its sandbox without asking appears in the agent's activity log, not the tool log.
- **Redaction is pattern-based.** A credential in an unusual format can get through. Chat messages are not scanned.
- **Webhook secrets** are stored in the database, not the vault. A webhook without a secret can be called by anyone who knows its address.
- **Some engine images are not pinned.** Codex, Gemini CLI and goose install the latest release when built. goose installs with its own download script.

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** (Security tab of the repo), not in public issues. We aim to reply within 3 working days. See [SECURITY.md](../SECURITY.md) for what is in scope and what we treat as a security bug.
