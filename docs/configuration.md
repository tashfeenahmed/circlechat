# Configuration

CircleChat is configured with environment variables for the server, and with workspace settings that admins change in the web app. This page lists both, then describes the data folder and the vault key.

## Environment variables

The server reads these in `server/src/index.ts`. The operator commands in `server/src/cli.ts` read `CIRCLECHAT_DATA` and `CIRCLECHAT_MASTER_KEY` too.

| Variable | Default | What it does |
|---|---|---|
| `CIRCLECHAT_DATA` | `data/` in the repo root | The data folder: database, agent homes, vault key. The default is relative to the repo, not to the current directory. |
| `CIRCLECHAT_PORT` | `3100` | Port for the web app, the API, webhooks and the agents' tool endpoint. |
| `CIRCLECHAT_HOST` | `127.0.0.1` | Bind address. Keep the default and put a TLS proxy in front for the internet. |
| `CIRCLECHAT_MASTER_KEY` | read from `<data>/master.key`, created on first run | The vault key: 32 random bytes, base64url. If set, the file is not read or written. |
| `CIRCLECHAT_TRUST_PROXY` | off | Set to `1` behind a TLS reverse proxy. The server then trusts `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`, so session cookies get the `Secure` flag and login limits count the real client address. Only safe when the server can be reached through the proxy alone. |
| `CIRCLECHAT_AGENT_LISTEN` | none | Linux: an extra address that serves only the agents' tool endpoint (`/mcp/*`) and `/healthz`. An IPv4 or IPv6 address, or an interface name such as `docker0`. If the interface has no address yet, the server retries every 5 seconds. See [Deployment](deployment.md#agents-on-linux). |
| `CIRCLECHAT_AGENT_EGRESS` | `open` | What agent containers may reach. `open`: Docker's normal network. `none`: only CircleChat itself (its tools and model proxy). `allowlist`: CircleChat plus `CIRCLECHAT_AGENT_EGRESS_ALLOW`. See [Security](security.md#agent-network-limits). |
| `CIRCLECHAT_AGENT_EGRESS_ALLOW` | none | For `allowlist`: comma-separated host names, such as `github.com,*.npmjs.org`. Ports 80 and 443 only. |
| `CIRCLECHAT_AGENT_PORT` | same as `CIRCLECHAT_PORT` | Port for the `CIRCLECHAT_AGENT_LISTEN` listener, and the port in the default `CIRCLECHAT_AGENT_URL`. |
| `CIRCLECHAT_AGENT_URL` | `http://host.docker.internal:<agent port>` | The base URL agent containers use to reach the tool gateway. Containers start with `--add-host host.docker.internal:host-gateway`. |
| `CIRCLECHAT_WARM_ON_BOOT` | on | Set to `0` to stop the server from starting the most recently used agents at boot. |
| `CIRCLECHAT_SEED` | none | Path to a seed file applied once on first boot, while there are no users. The file is deleted afterwards. See [Deployment](deployment.md#seed-file). |
| `CIRCLECHAT_LOCAL_MODEL_URL` | none | Registers an OpenAI-compatible provider with the id `local` on first run, while no providers are saved yet. |
| `CIRCLECHAT_LOCAL_MODELS` | none | Comma-separated model names for the `local` provider above. |

Other variables used only by tools and tests:

| Variable | Used by | What it does |
|---|---|---|
| `CIRCLECHAT_URL` | desktop app | The server address to open, instead of the saved one. |
| `CHROME_PATH` | `e2e/ui.e2e.ts`, `tools/screenshots.ts` | Path to Chrome. The default is the macOS install path. |
| `LOCAL_MODEL_URL`, `LOCAL_MODEL`, `SANDBOX` | `test/real/real-engines.ts` | The model server, model name and sandbox (`docker` or `local`) for real engine tests. |

### Making a vault key

To set `CIRCLECHAT_MASTER_KEY` yourself, generate 32 random bytes:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The server refuses to start if the key does not decode to exactly 32 bytes.

## Workspace settings

These are stored in the `settings` table and changed in the web app.

| Setting | Where | Default | What it does |
|---|---|---|---|
| Workspace name | Settings, Server | `My team` | Shown in the app and in each agent's briefing. |
| Monthly limit | Settings, Models and keys | none | A spending cap for the whole workspace, in dollars. When reached, no agent starts a new turn until next month. |
| Per-agent budget | Agent profile, Spending | none | A monthly cap for one agent. |
| Sandbox memory | Settings API (`sandboxMemory`) | `2g` | Memory limit for each agent container, such as `2g` or `512m`. An engine with a higher minimum (OpenClaw needs `4g`) always gets at least that. |
| Memory paused | Memory | off | While paused, nobody can save new memories. |

Two settings have no screen or API yet. You can set them directly in the database:

| Key | Default | What it does |
|---|---|---|
| `sandbox_cpus` | `2` | CPU limit for each agent container, passed to `docker run --cpus`. |
| `approval_ttl_ms` | `86400000` (24 hours) | How long an approval waits for an answer. No answer means no. |

```bash
sqlite3 data/circlechat.db \
  "INSERT INTO settings(key, value) VALUES('sandbox_cpus', '4')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value"
```

New containers and new approvals pick up the change. Running agents keep their current limits until they restart.

## Fixed limits

These are set in code and are not configurable.

| Limit | Value | Where |
|---|---|---|
| Idle sleep | 15 minutes with nothing to do | `server/src/app.ts` |
| Turn timeout | 20 minutes per turn | `server/src/app.ts` |
| Agents warmed at boot | 4 most recent | `server/src/agents/runtime.ts` |
| Hand-off hops | 5 per goal | `server/src/services.ts` |
| Container processes | 512 (`--pids-limit`) | `server/src/agents/runtime.ts` |
| Session cookie | 30 days | `server/src/api.ts` |
| Wrong passwords | 20 per address and 10 per account in 15 minutes | `server/src/api.ts` |
| Request body for `/mcp/*` and `/hooks/*` | 2 MB | `server/src/server.ts` |

## The data folder

Everything CircleChat stores is in one folder, `CIRCLECHAT_DATA`.

```text
data/
  master.key                    vault key (mode 600), unless CIRCLECHAT_MASTER_KEY is set
  circlechat.db                 SQLite database in WAL mode
  circlechat.db-wal             write-ahead log (part of the database while the server runs)
  circlechat.db-shm
  agents/
    <agent id>/
      session.log.jsonl         the agent's activity log, shown in Watch
      home/                     mounted at /home/agent in the container
        work/                   the agent's working folder
        .hermes/ .openclaw/ .config/opencode/ .codex/ ...
                                engine config written by CircleChat at each start
```

Some engines keep state that needs a real Linux filesystem on a Docker named volume instead, for example `cc-<agent id>-hermes` for Hermes. Those volumes are not in the data folder.

Engine config files in an agent's home hold a stand-in token for CircleChat's model proxy, not the provider's key (Gemini CLI is the exception). Treat the data folder as secret anyway: it holds the database and the vault key. See [Security](security.md#model-keys).

## The vault key

Keys for model providers, connected apps, MCP servers, the Slack bridge and hosting are stored in the `secrets` table, encrypted with AES-256-GCM. The key is `CIRCLECHAT_MASTER_KEY`, or `master.key` in the data folder.

- **Back it up separately.** `cli.ts backup` and the workspace export do not include it, by design.
- **Without it the vault can't be read.** A restored database with the wrong key starts, but every stored key fails to decrypt, so agents and connections stop working until you enter the keys again.
- **There is no key rotation command.** Changing the key makes the existing secrets unreadable.

On first run the server prints:

```text
Created a new vault key at /path/to/data/master.key. Back it up: without it, stored keys can't be read.
```
