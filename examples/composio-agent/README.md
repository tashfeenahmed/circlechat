# CircleChat × Composio — reference agent

A minimal CircleChat **webhook agent** whose toolset is the user's
[Composio](https://composio.dev) connections. Claude reads the message, decides
which connected-app tools to call (Gmail, GitHub, Slack, a CRM, …), Composio
executes them against the connected account, and the agent replies in the
channel.

This is the fastest way to see the integration work end-to-end — it runs as a
plain Node process, no containerised agent runtime required. For giving the
*bundled* Hermes/OpenClaw agents the same tools, see
[`../../docs/composio.md`](../../docs/composio.md).

## Prerequisites

- CircleChat running (`docker compose up` in the repo root).
- A [Composio](https://app.composio.dev) API key with at least one connected
  account for your `COMPOSIO_USER_ID`.
- An Anthropic API key.

## Run

```bash
cd examples/composio-agent
npm install                 # .npmrc sets legacy-peer-deps so this stays lean
cp .env.example .env        # fill in the four required keys
set -a; source .env; set +a
npm start                   # listens on :8790
```

## Point CircleChat at it

1. In CircleChat: **Members → Provision agent**, runtime **webhook**. Copy the
   bot token into `.env` as `CC_BOT_TOKEN` and restart the agent.
2. Register this agent's callback URL. CircleChat's API runs in Docker, so it
   reaches your host process via `host.docker.internal`:

   ```bash
   curl -X POST http://localhost/api/agents/$AGENT_ID/register \
     -H "Authorization: Bearer $CC_BOT_TOKEN" \
     -d '{"callbackUrl":"http://host.docker.internal:8790"}'
   ```

   (`$AGENT_ID` is shown on the agent's detail page.)
3. In any channel the agent is in, `@mention` it or DM it:
   *"@composio what are my 3 most recent GitHub issues?"* or
   *"draft and send a test email to me via Gmail."*

Read-only lookups run immediately. Outbound/write actions surface as tool calls
Claude makes directly here; if you want them gated behind a human click, use the
in-platform MCP path (which routes through CircleChat's approval gate) documented
in [`../../docs/composio.md`](../../docs/composio.md).

## How it works

```
CircleChat ──POST /event (context packet)──▶ this agent
                                              │  Claude (tools = your Composio tools)
                                              │  ├─ tool_use ─▶ composio.provider.handleToolCalls()
                                              │  └─ final text
                                              ▼
                          { actions: [ post_message ] } ──▶ CircleChat
```

`agent.mjs` is ~180 lines; the whole loop is `composio.tools.get(userId,
{toolkits})` → `anthropic.messages.create({ tools })` →
`composio.provider.handleToolCalls(userId, response)`.
