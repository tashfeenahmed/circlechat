# Composio — connect agents to your existing SaaS tools

CircleChat's built-in agents can plan, build, run code, browse, and ship
artifacts — but out of the box they can't *log into your existing tools*. This
integration closes that gap with [Composio](https://composio.dev): once you set
a `COMPOSIO_API_KEY`, every agent gains a `composio_*` toolset backed by **your**
connected accounts (Gmail, GitHub, Slack, Notion, Linear, HubSpot, …), and every
outbound call routes through CircleChat's existing **approval gate**.

It's fully opt-in and dormant until configured — no key, no behaviour change.

## Design

The Composio **SDK and API key live server-side only** (in the `api`/`worker`
containers). Agents never see them. They reach Composio the same way they reach
the rest of CircleChat: through a small MCP shim that proxies to `/agent-api`.

```
Agent (Hermes / OpenClaw / custom webhook)
   │  MCP: composio_list_tools · composio_execute · composio_connections
   ▼
composio-mcp.mjs          (dep-free stdio shim, runs inside the agent container)
   │  HTTP → /agent-api/composio/*   (discovery, read-only)
   │  HTTP → /agent-api/act          (execution, gated)
   ▼
Fastify API ── @composio/core ──▶ Composio ──▶ your connected accounts
   │  composio_execute action
   ├─ COMPOSIO_APPROVAL=all  → opens an approval card; a human clicks approve;
   │                            the call replays server-side (audit-logged)
   └─ COMPOSIO_APPROVAL=off  → runs immediately (still audit-logged)
```

Because execution goes through the same `composio_execute` action and the same
`applyActions` path as everything else, it inherits scope/risk/approval gating,
dedupe, and the audit trail for free — nothing bypasses the executor.

## Setup

1. **Get a Composio API key** and connect at least one account for your user id
   at [app.composio.dev](https://app.composio.dev). The "user id" (a.k.a. entity)
   is whatever identity owns those connections — e.g. `default` or your email.

2. **Configure CircleChat** (`.env`):

   ```bash
   COMPOSIO_API_KEY=comp_...
   COMPOSIO_USER_ID=default        # the entity whose connections agents act as
   COMPOSIO_TOOLKITS=github,gmail  # optional allow-list; empty = every connected toolkit
   COMPOSIO_APPROVAL=all           # all | writes | off  (default: all)
   ```

3. **Restart** so the `api` and `worker` pick up the env:

   ```bash
   docker compose up -d
   ```

That's it for the base stack. Any agent whose runtime speaks MCP (the bundled
Hermes/OpenClaw runtime, or your own) now sees the `composio_*` tools.

## How agents use it

Three MCP tools (self-describing; the model discovers, then acts):

| Tool | Purpose |
| --- | --- |
| `composio_connections` | List connected accounts + status + the approval policy. |
| `composio_list_tools` | Discover tool slugs + input schemas for a toolkit or search term. |
| `composio_execute` | Run one tool by `slug` with `arguments`. |

Typical turn: `composio_list_tools({ toolkits: "gmail" })` → pick
`GMAIL_SEND_EMAIL`, read its schema → `composio_execute({ slug:
"GMAIL_SEND_EMAIL", arguments: { … } })`.

## Approvals

`COMPOSIO_APPROVAL` controls the gate:

- **`all`** (default) — every `composio_execute` opens an approval card. The
  agent gets back `pending_approval` with an id (`ap_…`) and stops. A human
  approves it in the **Approvals** tab; the call then **replays server-side**
  from its stored payload (the human authorised exactly this slug + arguments),
  and a confirmation is posted to the originating conversation. The agent is also
  woken with an `approval_response` trigger.
- **`writes`** — read-only tools (`*_GET_*` / `*_LIST_*` / `*_SEARCH_*` …) run
  immediately and return data in the same turn; everything else is gated as
  above. Good default once you trust reads.
- **`off`** — everything runs immediately. Still fully audit-logged; use only on
  a trusted single-tenant deploy.

Approval cards show a truncated argument preview, so the human sees exactly what
will run before clicking approve.

## Bundled-agent runtime (Hermes / OpenClaw)

When Composio is enabled, the equip step registers a second MCP server
(`composio`) into each provisioned agent alongside `circlechat`, and stages the
dep-free `api/scripts/composio-mcp.mjs` into the agent's home. Nothing else is
required. Opt a single deploy out with `CC_COMPOSIO_MCP=off`.

## Custom / reference agent

Prefer to run an agent as a plain process (no container runtime)? The reference
webhook agent in [`examples/composio-agent`](../examples/composio-agent) uses
`@composio/core` + `@composio/anthropic` to drive Claude over your Composio tools
and reply in a channel — the fastest way to see the integration work end-to-end.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSIO_API_KEY` | — | Composio API key. **Unset = feature off.** |
| `COMPOSIO_USER_ID` | `default` | The Composio user/entity whose connected accounts agents act as. |
| `COMPOSIO_TOOLKITS` | *(empty)* | CSV allow-list of toolkit slugs to expose. Empty = every toolkit the user has connected. |
| `COMPOSIO_APPROVAL` | `all` | `all` \| `writes` \| `off` — approval policy for outbound calls. |
| `CC_COMPOSIO_MCP` | `on` | Set `off` to skip registering the composio MCP server into bundled agents. |

## Security notes

- The API key and the Composio SDK never enter an agent container — only the
  bot-token-authenticated `/agent-api/composio/*` proxy is reachable from there.
- Keep `COMPOSIO_APPROVAL=all` (or `writes`) on multi-tenant or shared deploys so
  a model can't send an email / open a PR without a human in the loop.
- Every Composio call is recorded on the agent's run and (when gated) as an
  approval row you can query.

## Roadmap

- Per-agent Composio identities (distinct connected accounts per agent, stored on
  `agents.config_json`) instead of one workspace-wide `COMPOSIO_USER_ID`.
- Surfacing the connect flow (`toolkits.authorize`) in the UI so admins can link
  accounts without leaving CircleChat.
