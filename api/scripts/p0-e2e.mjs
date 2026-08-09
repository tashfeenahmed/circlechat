#!/usr/bin/env node
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

const base = (process.env.CC_E2E_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const email = process.env.CC_E2E_EMAIL || "e2e@circlechat.local";
const password = process.env.CC_E2E_PASSWORD || "e2e-password";

let cookie = "";
async function request(path, { method = "GET", body, headers = {}, auth = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(auth && cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* text response */ }
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { status: response.status, data };
}

async function waitForRun(runId, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await request(`/api/workflow-runs/${runId}`);
    if (predicate(data.run)) return data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`workflow run ${runId} did not reach expected state`);
}

function log(check, detail = "") {
  console.log(`✓ ${check}${detail ? ` — ${detail}` : ""}`);
}

try {
  await request("/api/auth/login", { method: "POST", auth: false, body: { email, password } });
} catch (error) {
  if (error.status !== 401) throw error;
  await request("/api/auth/signup", {
    method: "POST",
    auth: false,
    body: {
      email,
      password,
      name: "E2E Admin",
      handle: "e2e-admin",
      workspaceName: "P0 Test Lab",
    },
  });
}
assert.ok(cookie.startsWith("cc_session="));
log("authenticated admin session");

const unique = Date.now().toString(36);
const modelName = `e2e-balanced-${unique}`;
const { data: connectorCreated } = await request("/api/connectors", {
  method: "POST",
  body: {
    name: `E2E health ${unique}`,
    kind: "http",
    baseUrl: `${base}/health`,
    authType: "none",
  },
});
const connectorId = connectorCreated.connector.id;
const { data: health } = await request(`/api/connectors/${connectorId}/check`, { method: "POST" });
assert.equal(health.ok, true);
log("connector registry and live health check", connectorId);

const { data: agentCreated } = await request("/api/agents", {
  method: "POST",
  body: {
    name: `Usage Agent ${unique}`,
    handle: `usage-${unique}`,
    kind: "custom",
    adapter: "webhook",
    callbackUrl: `${base}/health`,
    heartbeatIntervalSec: 86400,
    scopes: ["channels.read", "channels.reply", "tools.call"],
  },
});
await request(`/api/connectors/${connectorId}/grants/${agentCreated.id}`, {
  method: "PUT",
  body: { scopes: ["tools.call", "health.read"] },
});
const { data: connectorList } = await request("/api/connectors");
assert.ok(connectorList.connectors.find((row) => row.id === connectorId).grants.some((grant) => grant.agentId === agentCreated.id));
log("scoped per-agent connector grant", `@usage-${unique}`);

await request("/api/model-routing/balanced", {
  method: "PUT",
  body: {
    provider: "e2e-provider",
    model: modelName,
    inputCostPerMtok: 2,
    outputCostPerMtok: 8,
    cachedInputCostPerMtok: 0.5,
    contextWindow: 128000,
    enabled: true,
  },
});
const { data: runCreated } = await request(`/api/agents/${agentCreated.id}/test`, { method: "POST" });
await request(`/api/agent-api/runs/${runCreated.runId}/usage`, {
  method: "POST",
  auth: false,
  headers: { authorization: `Bearer ${agentCreated.botToken}` },
  body: {
    provider: "e2e-provider",
    model: modelName,
    inputTokens: 1000,
    outputTokens: 250,
    cachedInputTokens: 100,
  },
});
const { data: usage } = await request("/api/model-routing?days=1");
assert.ok(usage.usage.some((row) => row.model === modelName && row.source === "reported"));
assert.ok(usage.totals.reportedEvents >= 1);
log("model route plus runtime-reported actual usage", `${usage.totals.reportedEvents} reported event(s)`);

const webhookDefinition = {
  start: "wait",
  states: [
    { id: "wait", type: "wait", next: "done", config: { durationSeconds: 2 } },
    { id: "done", type: "terminal", config: { status: "completed", output: { accepted: true } } },
  ],
};
const { data: webhookWorkflow } = await request("/api/workflows", {
  method: "POST",
  body: { name: `Signed intake ${unique}`, triggerType: "webhook", definition: webhookDefinition },
});
const { data: hook } = await request(`/api/workflows/${webhookWorkflow.workflow.id}/webhooks`, {
  method: "POST",
  body: { name: "E2E inbound" },
});
const rawBody = JSON.stringify({ event: "e2e.created", id: unique, amount: 42 });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = `sha256=${createHmac("sha256", hook.signingSecret).update(timestamp).update(".").update(rawBody).digest("hex")}`;
let rejected = false;
try {
  await request(new URL(hook.endpoint.url).pathname, {
    method: "POST",
    auth: false,
    body: rawBody,
    headers: {
      "x-circlechat-delivery": `bad-${unique}`,
      "x-circlechat-timestamp": timestamp,
      "x-circlechat-signature": "sha256=bad",
    },
  });
} catch (error) {
  rejected = error.status === 401;
}
assert.equal(rejected, true);
const deliveryId = `delivery-${unique}`;
const { data: accepted } = await request(new URL(hook.endpoint.url).pathname, {
  method: "POST",
  auth: false,
  body: rawBody,
  headers: {
    "x-circlechat-delivery": deliveryId,
    "x-circlechat-timestamp": timestamp,
    "x-circlechat-signature": signature,
  },
});
assert.equal(accepted.accepted, true);
const { data: duplicate } = await request(new URL(hook.endpoint.url).pathname, {
  method: "POST",
  auth: false,
  body: rawBody,
  headers: {
    "x-circlechat-delivery": deliveryId,
    "x-circlechat-timestamp": timestamp,
    "x-circlechat-signature": signature,
  },
});
assert.equal(duplicate.duplicate, true);
const completedWebhook = await waitForRun(accepted.runId, (run) => run.status === "completed");
assert.deepEqual(completedWebhook.run.outputJson.done, { accepted: true });
assert.ok(completedWebhook.steps.some((step) => step.kind === "wait" && step.status === "completed"));
log("signed webhook, replay protection, durable timer resume", accepted.runId);

const approvalDefinition = {
  start: "approve",
  states: [
    { id: "approve", type: "approval", onSuccess: "wait", onFailure: "denied", config: { prompt: "Ship it?" } },
    { id: "wait", type: "wait", next: "done", config: { durationSeconds: 2 } },
    { id: "done", type: "terminal", config: { status: "completed" } },
    { id: "denied", type: "terminal", config: { status: "failed" } },
  ],
};
const { data: approvalWorkflow } = await request("/api/workflows", {
  method: "POST",
  body: { name: `Human gate ${unique}`, triggerType: "manual", definition: approvalDefinition },
});
const { data: approvalRun } = await request(`/api/workflows/${approvalWorkflow.workflow.id}/runs`, {
  method: "POST",
  body: { input: { release: unique } },
});
await waitForRun(approvalRun.runId, (run) => run.status === "waiting" && run.waitKind === "human");
await request(`/api/workflow-runs/${approvalRun.runId}/resume`, {
  method: "POST",
  body: { approved: true, output: { reviewer: "e2e-admin" } },
});
const completedApproval = await waitForRun(approvalRun.runId, (run) => run.status === "completed");
assert.ok(completedApproval.steps.some((step) => step.kind === "approval" && step.status === "completed"));
assert.ok(completedApproval.steps.some((step) => step.kind === "wait" && step.status === "completed"));
log("human resume followed by a second durable wait", approvalRun.runId);

// The test agent deliberately returns a bad webhook body. BullMQ retries that
// same run three times; billing must retain one idempotent worker event, not
// turn infrastructure retries into three model calls.
await new Promise((resolve) => setTimeout(resolve, 6_000));
const { data: retryUsage } = await request("/api/model-routing?days=1");
const retryEstimate = retryUsage.usage.find(
  (row) => row.model === modelName && row.source === "estimated",
);
assert.equal(retryEstimate?.events, 1);
const { data: agentDetail } = await request(`/api/agents/${agentCreated.id}`);
const meteredRun = agentDetail.recentRuns.find((run) => run.id === runCreated.runId);
assert.equal(meteredRun?.tokensEst, 1250);
log("worker retry usage is idempotent", "3 attempts → 1 estimated event");

console.log("\nP0 API E2E passed.");
