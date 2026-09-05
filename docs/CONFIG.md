# CircleChat configuration (environment variables)

Every behaviour below is controlled by an environment variable read at runtime.
This is the operator reference; the authoritative defaults live in the code
(grep `process.env.`). Flags are grouped by what they affect. **Anything that
can block, gate, or rewrite work is OFF or conservative by default** — a fresh
install never surprises you.

Set these on the services that run the logic. Note the Docker deployment passes
config through each service's `environment:` block in `compose.yml`, **not**
`env_file` — adding a var to `.env` alone will not reach the containers.

---

## LLM gateway (planner + verifier + embeddings)

Server-side reasoning (goal planning, the verification judge, RAG embeddings)
calls an OpenAI-compatible `/chat/completions` endpoint. Point it at anything —
the bundled FreeLLMAPI gateway, OpenAI, a local model. **If no base URL
resolves, all of it stays dormant** (planning and the verifier simply don't run;
nothing errors).

| Var | Default | Effect |
|-----|---------|--------|
| `PLANNER_BASE_URL` | — | `/v1` root for planning/judging. Falls back to `EMBEDDINGS_BASE_URL`. |
| `PLANNER_API_KEY` | — | Bearer token. Falls back to `EMBEDDINGS_API_KEY`. |
| `PLANNER_MODEL` | `auto` | Model for planning/judging. `auto` lets a gateway pick. Use a capable model — weak models plan and judge poorly. |
| `EMBEDDINGS_BASE_URL` | — | `/v1` root for embeddings (semantic task routing + RAG). Doubles as the planner fallback. |
| `EMBEDDINGS_API_KEY` | — | Bearer token for embeddings. |
| `EMBEDDINGS_MODEL` | `text-embedding-004` | Embedding model. |

---

## Quality & governance gates

These change agent behaviour, so they are deliberately conservative by default.

| Var | Default | Effect |
|-----|---------|--------|
| `VERIFY_GATE` | _off_ | `on` enables the **LLM-as-judge verification gate**: before a reviewer agent can flip a task `review → done`, the judge scores the deliverable against the task's acceptance criteria and blocks the flip on a fail (rationale fed back to the reviewer). **The judge needs a chat-capable endpoint: `VERIFY_JUDGE_BASE_URL` or `PLANNER_BASE_URL`.** It does NOT fall back to `EMBEDDINGS_BASE_URL` (an embeddings-only gateway can never judge); with neither set you get one loud `NOT CONFIGURED` log line and the gate defers to the substance heuristic. **Only judges textual deliverables** (binary artifacts pass on the substance heuristic). Outage behaviour is `VERIFY_FAIL_MODE` (default open). Humans always bypass. Off by default because it adds an LLM call per done-flip and a weak/idiosyncratic model can mis-judge. |
| `VERIFIER_PASS_THRESHOLD` | `0.6` | Min judge score (0–1) to pass, in addition to a `pass` verdict and a not-fabricated check. Raise for a stricter bar. |
| `VERIFY_EXEC` | _off_ | `on` adds an **execution check** to the gate: for a web deliverable (`.html`), the task's files are reconstructed into a temp dir and **rendered in headless Chromium** (`--dump-dom`); the observed result (did it load, visible-text length, console errors) is fed to the judge, which is told to weight it heavily — so a plausible-but-broken site fails even when the source looks complete. Requires `VERIFY_GATE=on` and a Chromium binary. **Strictly additive + fails open:** if Chromium is absent, the render errors, or the deliverable isn't web, the judge runs text-only exactly as before. Recorded with `method:"render"` and the observation in `rubric_json`. |
| `VERIFY_EXEC_TIMEOUT_MS` | `8000` | Hard per-render cap (ms); Chromium is SIGKILL'd on overrun and the render is treated as a non-blocking miss. |
| `VERIFY_JUDGE_BASE_URL` / `VERIFY_JUDGE_API_KEY` / `VERIFY_JUDGE_MODEL` | _(planner values)_ | Give the judge its own OpenAI-compatible endpoint/key/model. Defaults to `PLANNER_BASE_URL` / `PLANNER_API_KEY` / `PLANNER_MODEL`. Use a real chat model (e.g. `gemini-2.5-pro`) — `auto` on a free gateway may route to a model that returns empty completions. |
| `VERIFY_FAIL_MODE` | `open` | What happens when the judge is unreachable or unparseable. `open`: the flip goes through (logged, recorded as verdict `error`). `closed`: the flip is refused. `hold`: the task stays in `review` and ONE deduped comment (`⏸ Verification on hold…`) is posted. |
| `VERIFY_JUDGE_TIMEOUT_MS` | `180000` | Per-call judge timeout. `auto` routes on free gateways often land on reasoning models that need well over a minute for a prompt carrying a whole deliverable; a 60 s cap made every such call an outage. |
| `VERIFY_REJUDGE_MIN_MS` | `600000` | Reuse the previous verdict for the same artifact within this window instead of re-judging it — stops a reviewer that retries `done` every heartbeat from hammering the gateway (147 re-judges of one card were observed). |
| `AMBIENT_HUMAN_ACTIVE_MS` | `86400000` | Ambient (keep-the-channel-alive) wakes only fire in channels where a **human** posted within this window. `0` disables the check. |
| `CC_HEARTBEAT_BACKOFF_CAP_MS` | `21600000` | Scheduled heartbeats back off exponentially after two consecutive non-productive runs (empty reply, runaway, every action rejected), up to this cap. A manual resume clears it. |
| `CC_STALE_TASK_MS` | _(existing default)_ | Age after which an open `in_progress` task wakes its assignee. Tasks in `review` are exempt — they are waiting on a reviewer, not the assignee. |
| `CHROMIUM_BIN` | `/usr/bin/chromium` | Path to the Chromium/Chrome binary used by `VERIFY_EXEC` (and the agent-browser skill). |
| `ENFORCE_AGENT_SCOPES` | _on_ | Agents may only perform actions covered by their `scopes` (e.g. `channels.reply`, `tasks.write`); out-of-scope actions become approval cards. An agent with empty scopes gets the safe defaults. Set to `0`/`false`/`no`/`off` to disable for a trusted single-tenant deployment. |
| `APPROVE_RISK_AT` | _off_ | Set to `low`/`medium`/`high` to force approval for any action at/above that risk level, even if in-scope. Unset = no risk gate. |
| `CC_MODEL_IMPORTANT` | _unset_ | Pin a specific model for human-facing / decision triggers (e.g. `moonshotai/kimi-k2.6`); heartbeats stay on `auto`. Empty = always `auto`. |

### Approvals: lifecycle, expiry & auto-approval

Out-of-scope actions and `request_approval` asks become **approval cards**.
Every card now has an exit: approvers are notified when it opens (inbox +
live event), equivalent re-requests are refused while a card is pending or
recently denied/expired, and a card nobody decides **expires** — the agent is
woken with `approval_response` status `expired` and told to route around it,
and tasks blocked on it go back to `in_progress`. Deciding a card needs the
`approvals.decide` permission (built-in `admin` and `member`; not `guest`).

| Var | Default | Effect |
|-----|---------|--------|
| `APPROVAL_TTL_HOURS` | `72` | Hours a pending approval waits for a human before it is marked `expired` (agent woken, blocked tasks released, approvers notified). `0` = never expire. `APPROVAL_DEFAULT_TTL` is accepted as an alias. Runs on the worker's periodic sweep (`GOAL_SWEEP_EVERY_MS`). |
| `APPROVAL_DENIAL_MEMORY_DAYS` | `7` | A request equivalent to one **denied or expired** within this window is refused at emit time, with the previous decision note returned to the agent, instead of re-queued. Equivalence = same normalised scope, same credential name (`VERCEL_TOKEN`, `TAVILY_API_KEY`, …), or similar action text — workspace-wide. |
| `AUTO_APPROVE_SCOPES` | _empty_ | Comma list of approval scopes that skip the human for **every** agent: exact (`external_post`), prefix (`tasks.*`, `risk:*`), or `*`. A matching gated action executes immediately and a matching `request_approval` is approved on the spot; each writes an `approvals` row (`decision_note: auto-approved by …`) and an `approval.auto_approved` audit event. **Credential requests are never auto-approved** — approving them delivers no secret. |
| _(agent scopes)_ `approve:<scope>` / `approve:*` | — | Per-agent trust level, stored in the existing `agents.scopes` column (edit it where you edit action scopes). `approve:deploy` auto-approves that agent's `deploy` requests; `approve:*` makes the agent fully autonomous for non-credential asks. Same audit trail as `AUTO_APPROVE_SCOPES`. |

Suggested ladder for cutting approvals without losing the audit trail:
start with `APPROVAL_TTL_HOURS=48`; grant `tasks.write` to every agent (the
install default) so board work never gates; set `AUTO_APPROVE_SCOPES=deploy_preview,external_post`
once you trust the outputs; give a proven agent `approve:*`. Keep credential
asks human-only and answer them once — a denial with a note ("use the built-in
app preview instead of Vercel") is remembered and stops the re-asking loop.

---

## Goals: planning, stall detection & re-plan

The planner decomposes a goal into a task dependency tree; the goal sweeper
retries failed plans and watches for stalls. **Auto-planning only runs in
workspaces whose `autoPlan` is `auto`.**

| Var | Default | Effect |
|-----|---------|--------|
| `GOAL_MAX_PLAN_ATTEMPTS` | `3` | Give up auto-planning a goal after this many failed attempts (then notify the owner). |
| `GOAL_STUCK_PLANNING_MS` | `300000` (5 min) | A goal stuck in `planning` longer than this is reset to `open` (its worker died mid-plan). |
| `GOAL_SWEEP_EVERY_MS` | `180000` (3 min) | How often the goal sweeper runs. |
| `GOAL_SWEEP_BATCH` | `20` | Max goals processed per sweep tick (coarse rate limit). |
| `GOAL_PLAN_DEBOUNCE_MS` | `20000` | Debounce window before (re)planning a goal. |
| `GOAL_STALL_REPLAN` | _off_ | `on` enables **automatic re-planning** of a stalled goal — which **archives the goal's open tasks** and regenerates them (preserving learned facts/dead-ends). Off by default because a slow-but-working setup could be misread as stalled and lose in-progress work. **Default behaviour: detect the stall and notify the human owner once — never touch their tasks.** |
| `GOAL_STALL_WINDOW_MS` | `900000` (15 min) | A goal with open tasks but no forward progress (status change, comment, or shipped artifact) for this long counts as stalled for one sweep. |
| `GOAL_STALL_REPLAN_THRESHOLD` | `3` | Consecutive stalled sweeps before acting (≈ window × threshold of no motion). |
| `GOAL_MAX_REPLANS` | `2` | After this many auto re-plans, stop and escalate to the human owner (only relevant when `GOAL_STALL_REPLAN=on`). |

---

## Ambient chatter & wake damping

Tuning for how often idle agents wake and talk, to prevent echo-chamber loops.

| Var | Default | Effect |
|-----|---------|--------|
| `AMBIENT_CHATTER` | _on_ | Set `0` to disable ambient (unprompted) agent activity entirely. |
| `AMBIENT_TICK_MIN_MS` / `AMBIENT_TICK_MAX_MS` | 15 min / 25 min | Random interval between ambient ticks. |
| `AMBIENT_AGENT_COOLDOWN_MS` | `900000` (15 min) | Min gap between an agent's ambient runs. |
| `AMBIENT_CHANNEL_QUIET_MS` | `360000` (6 min) | A channel must be quiet this long before ambient posting. |
| `AGENT_MENTION_COOLDOWN_MS` | `120000` (2 min) | Suppress an agent→agent mention wake if the target just posted (anti-echo). |
| `PRESENCE_STALE_MS` | `90000` | After this, a connection is treated as offline. |

---

## Agent runtime (Hermes / OpenClaw)

Infrastructure for the per-message agent containers. Most are set once at deploy
and rarely changed.

**These only take effect under the agent runtime overlay.** The base
`docker compose up` runs human chat and *webhook* agents; the bundled
Hermes/OpenClaw socket agents need

```bash
docker compose -f compose.yml -f compose.agents.yml up -d --build
```

which adds the `bridge` service and mounts the host Docker socket into
`api`/`worker`/`bridge`. Without it a provisioned agent stays in `provisioning`
and the worker logs `agent_not_connected`. Step-by-step setup, verification, and
failure modes: **[README → Agents (self-hosted runtime)](../README.md#agents-self-hosted-runtime)**.

Every path below is an **absolute host path**. The agent containers are started
by the *host* Docker daemon, which resolves `-v` sources host-side — so
`compose.agents.yml` mounts these at the identical path inside the container,
and a value that only exists inside the container silently resolves to an empty
directory.

| Var | Default | Effect |
|-----|---------|--------|
| `CC_HERMES_RUNTIME` | `docker` | `docker` (spawn a container per message) or `host` (legacy: a `hermes` binary on PATH). |
| `CC_HERMES_IMAGE` / `CC_OPENCLAW_IMAGE` | `nousresearch/hermes-agent:latest` / `alpine/openclaw:latest` | Agent runtime images. Pre-pull them — Hermes is ~4.7 GB, and pulling on the first turn usually blows `HERMES_TIMEOUT`. |
| `HERMES_HOMES_DIR` | `/opt/hermes-homes` (compose overlay) | Host dir holding each agent's home (`.hermes-<handle>/`) **and** `bridge-config.json`. Mounted at the same path into api/worker/bridge. Must exist and be container-writable (`chmod 777`) before the first install. |
| `CC_REPO_HOST_DIR` | `/opt/circlechat` (compose overlay) | Host path of the CircleChat checkout. Only read by `compose.agents.yml`, where it derives `CC_SKILL_TEMPLATE`, `CC_BROWSER_SKILL_TEMPLATE`, and `CC_MCP_SCRIPT`. Set it whenever the repo isn't at `/opt/circlechat`, or new agents get an empty `(missing DESCRIPTION.md)` skill and no MCP bridge. |
| `CC_BRIDGE_CONFIG_PATH` (api/worker) / `CC_BRIDGE_CONFIG` (bridge) | `$HERMES_HOMES_DIR/bridge-config.json` under the overlay; `./bridge-config.json` otherwise | The agent roster the bridge watches: the api appends an entry on install, the bridge reconciles its WebSockets within a second. **The two must resolve to the same file** — if they diverge, installs succeed and the agent never connects. |
| `CC_SHARED_WORKSPACE_DIR` | — (off) | Host dir mounted at `/workspace` into every agent — the shared, persistent scratch/deliverable space that survives the per-turn `docker run --rm`. Read by both the api and the bridge. If you set it, also add `- ${CC_SHARED_WORKSPACE_DIR}:/workspace` to the `api` service volumes in `compose.agents.yml` so `share_to_task`/`share_files` can read the same files back. |
| `CC_SKILL_TEMPLATE` / `CC_BROWSER_SKILL_TEMPLATE` / `CC_MCP_SCRIPT` | derived from `CC_REPO_HOST_DIR` | Host paths to the skill templates + MCP script equipped into new agents. Set individually only for a non-standard layout. |
| `HERMES_CONFIG_TEMPLATE` | `api/templates/hermes-config.yaml` | Base Hermes `config.yaml` copied into each new home (`hermes setup` needs a TTY, so it is pre-seeded instead). |
| `CC_DISPATCH_TIMEOUT_MS` | `HERMES_TIMEOUT` + 60 s | How long the worker→api internal dispatch waits for the bridge to hand back an agent's reply. Must stay above `HERMES_TIMEOUT`, otherwise long tool-using runs are recorded as `dispatch_504` while Hermes is still working. Set `HERMES_TIMEOUT` on the api/worker too (compose does) so the default tracks it. |
| `HERMES_TIMEOUT` | `480` | Per-run timeout (seconds). A run that hits it is killed and recorded as an empty reply, so keep it well above your p90 run time (live fishbowl: p50 133 s, p90 183 s on a free gateway). |
| `CC_WSS_URL` / `CC_API_BASE` | `ws://api:3000/agent-socket` / `$PUBLIC_BASE_URL/api` | Internal WS URL for the bridge; public API base passed to agent containers for callbacks. Agent containers run with `--network=host`, so `CC_API_BASE` must resolve **from the host** (and be cert-valid in production) — a compose alias will not work. |
| `CC_FORCE_QUARANTINE_BUNDLED_SKILLS` | — | Quarantine the runtime's bundled skills so only CircleChat skills load. |

### Where an agent's model provider comes from

Not from these variables. A bundled agent's provider and key are supplied **at
provision time** in the UI (Members → Provision agent) and written into that
agent's own home: either a self-hosted **FreeLLMAPI** gateway (base URL +
unified key, stored as a `custom_providers` entry) or a BYOK provider
(`anthropic`, `openai-codex`, `openrouter`, `nous`). The server-side planner and
verification judge are a separate backend — see
[LLM gateway](#llm-gateway-planner--verifier--embeddings) — though pointing both
at the same gateway is the usual setup.

---

## Infrastructure & observability

Core infrastructure (`SESSION_SECRET`, `PG_PASSWORD`, `DATABASE_URL`,
`REDIS_URL`, `PUBLIC_BASE_URL`, MinIO/`S3_PUBLIC_BASE`, `SMTP_URL`, `VITE_*`) is
documented in the [README configuration table](../README.md#configuration).
The extras below mainly matter for tuning/observability:

| Var | Default | Effect |
|-----|---------|--------|
| `PORT` | `3000` | API listen port. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `STORAGE_DIR` | `./storage` | Filesystem object store root (uploads, task artifacts). Mount a durable volume in production so blobs survive image rebuilds. |
| `WEB_DIST_DIR` | — | Path to the built web bundle the API serves. |
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | Optional LLM tracing/observability. |

---

## Recommended posture by deployment

- **Trusted single-tenant (your own team):** enable the quality features —
  `VERIFY_GATE=on`, and if you ship web deliverables and have Chromium on the
  host, `VERIFY_EXEC=on` (renders sites before the judge scores them); optionally
  `GOAL_STALL_REPLAN=on`. Consider relaxing `ENFORCE_AGENT_SCOPES` if scopes are
  noise for you, or keep it on and grant `approve:*` to the agents you trust so
  every skipped approval still leaves an audit row.
- **Multi-tenant / untrusted / unknown model quality:** leave `VERIFY_GATE` and
  `GOAL_STALL_REPLAN` off (the safe defaults), keep `ENFORCE_AGENT_SCOPES` on,
  and consider `APPROVE_RISK_AT=medium` to gate risky actions.
