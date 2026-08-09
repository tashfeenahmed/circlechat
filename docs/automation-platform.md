# Automation platform

CircleChat's P0 automation layer connects five primitives into one auditable path:

1. A workspace installs a governed HTTP or MCP connector.
2. Credentials are encrypted at rest and access is granted to named agents with scopes.
3. A manual call or signed webhook creates a persisted workflow run.
4. The worker advances one agent, connector, approval, timer, poll, or terminal state at a time.
5. Agent runtimes receive a model-route recommendation and report actual provider usage.

Postgres is the source of truth for runs, waits, attempts, webhook deliveries, grants, and usage. Redis/BullMQ schedules wakes and retries, but deleting or restarting a worker does not erase workflow state.

## Connector and MCP registry

Connectors are managed under **Automation → Connectors** or `/api/connectors`.

| Capability | HTTP connector | MCP connector |
| --- | --- | --- |
| Transport | Governed REST request | MCP JSON-RPC over HTTP |
| Invocation | Method, path, query, headers, JSON body | `tools/call` with tool name and arguments |
| Health check | `GET` base URL or configured `healthPath` | `tools/list` |
| Authentication | None, bearer, custom headers, OAuth 2 | Same |
| Agent access | Explicit grant plus scopes | Explicit grant plus scopes |

Public configuration (`baseUrl`, health path, OAuth URLs/client id/scopes) is stored separately from credentials. Credential envelopes use AES-256-GCM with a key domain-derived from `SESSION_SECRET`; API responses expose only `hasSecret`.

### Generic OAuth 2

Set `authType` to `oauth2` and include this public configuration:

```json
{
  "oauth": {
    "authorizationUrl": "https://provider.example/oauth/authorize",
    "tokenUrl": "https://provider.example/oauth/token",
    "clientId": "circlechat-client-id",
    "scopes": ["records.read", "records.write"]
  }
}
```

Store `clientSecret` through the create or patch endpoint. `POST /api/connectors/:id/oauth/start` returns the provider authorization URL. The callback uses encrypted, ten-minute state bound to the connector/workspace and stores access/refresh tokens in the credential envelope.

### Workflow connector state

```json
{
  "id": "update_crm",
  "type": "connector",
  "onSuccess": "wait_for_sync",
  "onFailure": "failed",
  "config": {
    "connectorId": "conn_…",
    "agentId": "a_…",
    "method": "POST",
    "path": "/deals/$input.deal.id",
    "body": {
      "stage": "$input.stage",
      "summary": "$steps.research.summary"
    }
  }
}
```

When `agentId` is present, the connector must be granted to that agent. Exact template expressions preserve JSON types; embedded expressions stringify. `$input.*` addresses run input and `$steps.<state>.*` addresses prior state output.

## Durable workflows

A workflow definition contains a `start` state id and up to 100 states:

```json
{
  "start": "research",
  "states": [
    {
      "id": "research",
      "type": "agent",
      "onSuccess": "human_review",
      "onFailure": "failed",
      "config": { "agentId": "a_…" }
    },
    {
      "id": "human_review",
      "type": "approval",
      "onSuccess": "cooldown",
      "onFailure": "failed",
      "config": { "prompt": "Approve the researched recommendation?" }
    },
    {
      "id": "cooldown",
      "type": "wait",
      "next": "done",
      "config": { "durationSeconds": 300 }
    },
    { "id": "done", "type": "terminal", "config": { "status": "completed" } },
    { "id": "failed", "type": "terminal", "config": { "status": "failed" } }
  ]
}
```

| State | Required configuration | Behaviour |
| --- | --- | --- |
| `agent` | `agentId` | Enqueues an agent run, parks the workflow, and resumes the exact step after the final successful/failed attempt. |
| `connector` | `connectorId` | Calls HTTP or MCP and records the bounded response. |
| `approval` | Optional `prompt` | Parks on a human decision; resume with `POST /api/workflow-runs/:id/resume`. |
| `wait` | `durationSeconds` | Stores `waitUntil`, schedules a delayed wake, then resumes the same step. |
| `poll` | `connectorId`; optional `path`, `equals`, `intervalSeconds`, `timeoutSeconds` | Calls a connector until the response path matches or the durable timeout branch fires. |
| `terminal` | `status: completed|failed` | Finalizes output/error and timestamps the run. |

Transitions use `onSuccess`, `onFailure`, then `next` as the fallback. A state with no transition finalizes successfully or unsuccessfully according to its outcome. Every attempt is written to `workflow_steps` with input, output, errors, agent-run correlation, and timestamps.

## Signed incoming webhooks

Create an endpoint with `POST /api/workflows/:id/webhooks`. The response shows the signing secret once.

Send these headers:

```text
X-CircleChat-Delivery: unique-provider-delivery-id
X-CircleChat-Timestamp: unix-seconds
X-CircleChat-Signature: sha256=<hex HMAC>
Content-Type: application/json
```

The signed bytes are:

```text
<timestamp>.<exact raw HTTP body>
```

Example (Node.js):

```js
const signature = `sha256=${createHmac("sha256", secret)
  .update(timestamp)
  .update(".")
  .update(rawBody)
  .digest("hex")}`;
```

CircleChat rejects missing/tampered signatures and timestamps outside the five-minute replay window. `(endpoint, delivery id)` is unique: repeating a valid provider delivery returns its original run instead of starting a second run. Rotate secrets with `POST /api/webhooks/:id/rotate`.

## Model routing and actual usage

Configure `economy`, `balanced`, `frontier`, and `advisor` routes under **Automation → Models & usage** or `PUT /api/model-routing/:tier`.

Each route records provider/model, context window, and per-million-token prices for uncached input, cached input, and output. CircleChat recommends a tier from the trigger and workload signals; an explicit requested tier wins. The recommendation appears in the context packet:

```json
{
  "modelRoute": {
    "tier": "frontier",
    "provider": "example",
    "model": "reasoning-model",
    "contextWindow": 200000
  }
}
```

Runtimes may return usage with their normal response:

```json
{
  "actions": [],
  "usage": {
    "provider": "example",
    "model": "reasoning-model",
    "inputTokens": 1240,
    "outputTokens": 310,
    "cachedInputTokens": 600
  }
}
```

For gateways that report asynchronously, agents can call `POST /api/agent-api/runs/:runId/usage` with the same usage object and their bearer token. Multiple model calls per run remain separate; the worker's own event is idempotent across BullMQ retries. Reported totals replace the run's estimate. The UI always labels rows `reported` or `estimated`.

## Verification

Pure/unit suite:

```bash
cd api
npm test
```

Full P0 API E2E (requires a migrated API and worker plus the seeded/admin credentials):

```bash
cd api
CC_E2E_BASE_URL=http://127.0.0.1:3000 \
CC_E2E_EMAIL=e2e@circlechat.local \
CC_E2E_PASSWORD=e2e-password \
npm run test:p0-e2e
```

The E2E covers connector health, agent grants, model route/actual usage, bad and valid signatures, duplicate delivery protection, timer resume, human resume, and retry-idempotent usage.
