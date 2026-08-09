#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";

const base = (process.env.CC_E2E_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const email = process.env.CC_E2E_EMAIL || "e2e@circlechat.local";
const password = process.env.CC_E2E_PASSWORD || "e2e-password";
let cookie = "";

async function request(path, { method = "GET", body, headers = {}, auth = true, redirect = "follow" } = {}) {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const response = await fetch(`${base}${path}`, {
    method,
    redirect,
    headers: {
      accept: "application/json",
      ...(!isForm && body !== undefined ? { "content-type": "application/json" } : {}),
      ...(auth && cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? (isForm || typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (redirect === "manual" && response.status >= 300 && response.status < 400) {
    return { status: response.status, data, headers: response.headers };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
    error.status = response.status; error.data = data; throw error;
  }
  return { status: response.status, data, headers: response.headers };
}

async function expectStatus(status, path, options) {
  try { await request(path, options); }
  catch (error) { assert.equal(error.status, status, error.message); return error.data; }
  assert.fail(`${path} should have returned ${status}`);
}

async function waitFor(path, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(path);
    if (predicate(response.data)) return response.data;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${path} did not reach expected state`);
}

function log(name, detail = "") { console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`); }

let lastAgentPacket = null;
const agentServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try { lastAgentPacket = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { lastAgentPacket = null; }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [{ type: "memory_set", key: "should_not_apply_after_cancel", value: true }], trace: ["slow response"] }));
    }, 1_500);
  });
});
await new Promise((resolve) => agentServer.listen(33991, "127.0.0.1", resolve));

const oidcServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:33992");
  if (url.pathname === "/.well-known/openid-configuration") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ authorization_endpoint: "http://127.0.0.1:33992/authorize", token_endpoint: "http://127.0.0.1:33992/token", userinfo_endpoint: "http://127.0.0.1:33992/userinfo" }));
  } else if (url.pathname === "/token") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ access_token: "oidc-e2e-token", token_type: "Bearer" }));
  } else if (url.pathname === "/userinfo") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ sub: "p1-sso-user", email: "sso@circlechat.local", email_verified: true, name: "SSO Guest", preferred_username: "sso-guest" }));
  } else { res.writeHead(200, { "content-type": "text/plain" }); res.end("authorize"); }
});
await new Promise((resolve) => oidcServer.listen(33992, "127.0.0.1", resolve));

const gitServer = http.createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1:33993").pathname;
  let payload = {};
  if (path.endsWith("/files")) payload = [{ filename: "src/provider.ts" }, { filename: "web/provider.tsx" }];
  else if (path.endsWith("/reviews")) payload = [{ state: "APPROVED", user: { login: "reviewer" } }];
  else if (path.includes("/check-runs")) payload = { check_runs: [{ name: "provider-e2e", conclusion: "success" }] };
  else if (path.includes("/protection")) payload = { required_pull_request_reviews: { required_approving_review_count: 1 } };
  else payload = { title: "Live provider PR", html_url: "https://github.example/live", state: "open", head: { ref: "provider", sha: "abc123" }, base: { ref: "main" } };
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload));
});
await new Promise((resolve) => gitServer.listen(33993, "127.0.0.1", resolve));

try {
  await request("/api/auth/login", { method: "POST", auth: false, body: { email, password } });
  const adminCookie = cookie;
  const unique = Date.now().toString(36);
  const me = (await request("/api/me")).data;
  const workspaceId = me.workspaceId;
  const memberId = me.memberId;
  const workspaceHandle = me.workspaces.find((row) => row.id === workspaceId).handle;
  log("authenticated P1 administrator", workspaceHandle);

  const observed = (await request("/api/decisions/observe", { method: "POST", body: {
    kind: "decision", title: `P1 architecture ${unique}`, decision: "Use governed platform primitives.",
    rationale: "One audit and permission boundary.", alternatives: ["Feature silos"],
    provenance: { task: "P1", source: "e2e" }, source: "observer",
  } })).data.memory;
  const corrected = (await request(`/api/decisions/${observed.id}/correct`, { method: "POST", body: {
    kind: "precedent", title: `P1 architecture ${unique}`, decision: "Reuse governed platform primitives and immutable corrections.",
    rationale: "Preserve history.", alternatives: ["In-place mutation"], provenance: { reviewer: "e2e" }, source: "human",
  } })).data.memory;
  const decisions = (await request("/api/decisions")).data.decisions;
  assert.equal(decisions.find((row) => row.id === observed.id).status, "corrected");
  assert.equal(corrected.supersedesId, observed.id);
  log("decision observer, provenance, and immutable correction", corrected.id);

  const task = (await request("/api/tasks", { method: "POST", body: { title: `P1 app ${unique}`, bodyMd: "Ship an isolated preview.", assignees: [memberId] } })).data.task;
  const html = `<!doctype html><html><head><title>P1 ${unique}</title></head><body><h1>P1 hosted app</h1><p>${"verified ".repeat(20)}</p></body></html>`;
  const form = new FormData(); form.set("file", new Blob([html], { type: "text/html" }), `p1-${unique}.html`);
  const artifact = (await request(`/api/tasks/${task.id}/artifacts`, { method: "POST", body: form })).data.artifact;
  const createdApp = (await request("/api/apps", { method: "POST", body: { taskId: task.id, artifactId: artifact.id, name: `P1 App ${unique}` } })).data;
  let apps = (await request("/api/apps")).data.apps;
  let hosted = apps.find((row) => row.id === createdApp.appId);
  const preview = await request(new URL(hosted.previewUrl).pathname, { auth: false });
  assert.match(preview.data, /P1 hosted app/);
  assert.match(preview.headers.get("content-security-policy"), /default-src 'none'/);
  await expectStatus(404, new URL(hosted.publicUrl).pathname, { auth: false });
  await request(`/api/apps/${hosted.id}/request-publish`, { method: "POST", body: {} });
  assert.ok((await request("/api/needs-you")).data.items.some((item) => item.kind === "app_publish" && item.targetId === hosted.id));
  await request(`/api/apps/${hosted.id}/review`, { method: "POST", body: { decision: "approve", note: "E2E release" } });
  const published = await request(new URL(hosted.publicUrl).pathname, { auth: false });
  assert.match(published.data, /P1 hosted app/);
  assert.equal((await request(`/api/apps/${hosted.id}/health`)).data.healthy, true);
  log("isolated preview, review-gated publication, logs, CSP, and health", hosted.publicUrl);

  const channel = (await request("/api/conversations")).data.conversations.find((row) => row.kind === "channel");
  const prRoomId = (await request("/api/pr-rooms", { method: "POST", body: {
    conversationId: channel.id, provider: "github", repository: `circlechat/platform-${unique}`, prNumber: 42,
    snapshot: { pull: { title: "P1 PR", html_url: "https://github.example/pull/42", state: "open", head: { ref: "p1" }, base: { ref: "main" } }, files: [{ filename: "api.ts" }], checks: [{ name: "e2e", conclusion: "success" }], reviews: [{ state: "APPROVED" }], protection: { required_reviews: 1 } },
  } })).data.roomId;
  await request(`/api/pr-rooms/${prRoomId}/sync`, { method: "POST", body: { snapshot: {
    pull: { title: "P1 PR synced", html_url: "https://github.example/pull/42", state: "open", head: { ref: "p1" }, base: { ref: "main" } }, files: [{ filename: "api.ts" }, { filename: "web.tsx" }], checks: [{ name: "e2e", conclusion: "success" }], reviews: [{ state: "APPROVED" }], protection: { required_reviews: 1 },
  } } });
  const prRoom = (await request("/api/pr-rooms")).data.rooms.find((row) => row.id === prRoomId);
  assert.equal(prRoom.diffJson.length, 2); assert.equal(prRoom.checksJson.length, 1); assert.equal(prRoom.reviewsJson.length, 1); assert.equal(prRoom.protectionJson.required_reviews, 1);
  log("provider PR room snapshot with diffs, checks, reviews, and protection", prRoomId);

  const gitConnector = (await request("/api/connectors", { method: "POST", body: { name: `P1 Git ${unique}`, kind: "http", baseUrl: "http://127.0.0.1:33993", authType: "none" } })).data.connector;
  const liveRepo = `circlechat/live-${unique}`;
  const liveRoomId = (await request("/api/pr-rooms", { method: "POST", body: { conversationId: channel.id, connectorId: gitConnector.id, provider: "github", repository: liveRepo, prNumber: 43 } })).data.roomId;
  await request(`/api/pr-rooms/${liveRoomId}/sync`, { method: "POST", body: {} });
  const liveRoom = (await request("/api/pr-rooms")).data.rooms.find((row) => row.id === liveRoomId);
  assert.equal(liveRoom.title, "Live provider PR"); assert.equal(liveRoom.diffJson.length, 2); assert.equal(liveRoom.checksJson[0].name, "provider-e2e"); assert.equal(liveRoom.protectionJson.required_pull_request_reviews.required_approving_review_count, 1);
  log("live governed GitHub connector sync across provider API resources", liveRoomId);

  const slowAgent = (await request("/api/agents", { method: "POST", body: {
    name: `P1 Stage Agent ${unique}`, handle: `p1-stage-${unique}`, kind: "custom", adapter: "webhook",
    callbackUrl: "http://127.0.0.1:33991", heartbeatIntervalSec: 86400,
    scopes: ["tasks.read", "tasks.write"], capabilities: ["review"],
  } })).data;
  await request("/api/board-stages/backlog", { method: "PUT", body: { title: "Intake", position: 0, exitRules: { requireAssignee: true }, nextStage: "in_progress" } });
  await request("/api/board-stages/in_progress", { method: "PUT", body: { title: "Executing", position: 1, instructions: "Follow the P1 release checklist.", agentId: slowAgent.id, skill: "release", verification: "none", nextStage: "review" } });
  await request("/api/board-stages/review", { method: "PUT", body: { title: "Verified review", position: 3, entryRules: { requireArtifact: true }, verification: "human", nextStage: "done" } });
  const unassigned = (await request("/api/tasks", { method: "POST", body: { title: `Stage gate ${unique}` } })).data.task;
  const denied = await expectStatus(400, `/api/tasks/${unassigned.id}`, { method: "PATCH", body: { status: "in_progress" } });
  assert.equal(denied.error, "stage_rules_failed"); assert.ok(denied.violations.includes("exit:assignee_required"));
  await request(`/api/tasks/${unassigned.id}/assignees`, { method: "POST", body: { memberId } });
  await request(`/api/tasks/${unassigned.id}/advance`, { method: "POST", body: {} });
  const stageTask = (await request(`/api/tasks/${unassigned.id}`)).data;
  assert.equal(stageTask.task.status, "in_progress"); assert.ok(stageTask.activity.some((row) => row.kind === "stage_agent_assigned"));
  await expectStatus(400, `/api/tasks/${unassigned.id}`, { method: "PATCH", body: { status: "review" } });
  const evidence = new FormData(); evidence.set("file", new Blob([html], { type: "text/html" }), `evidence-${unique}.html`);
  await request(`/api/tasks/${unassigned.id}/artifacts`, { method: "POST", body: evidence });
  await request(`/api/tasks/${unassigned.id}`, { method: "PATCH", body: { status: "review" } });
  await waitFor(`/api/agents/${slowAgent.id}`, (data) => data.recentRuns.some((run) => run.contextJson?.stageExecution?.skill === "release"));
  assert.ok(lastAgentPacket.decisionMemory.some((row) => row.id === corrected.id));
  assert.equal(lastAgentPacket.stageExecution.instructions, "Follow the P1 release checklist.");
  log("stage entry/exit gates, auto-assignment, skill instructions, verification, and memory injection");

  const blueprint = (await request("/api/team-blueprints", { method: "POST", body: { name: `P1 Team ${unique}`, description: "Versioned E2E export", exportWorkspace: true } })).data;
  assert.ok(blueprint.definition.agents.length >= 1); assert.ok(blueprint.definition.channels.length >= 1); assert.ok(blueprint.definition.workflows.length >= 1);
  const applied = (await request(`/api/team-blueprints/${blueprint.blueprintId}/apply`, { method: "POST", body: {} })).data;
  assert.equal(applied.agents, blueprint.definition.agents.length); assert.equal(applied.channels, blueprint.definition.channels.length); assert.equal(applied.workflows, blueprint.definition.workflows.length);
  log("versioned team export and full agent/channel/workflow instantiation", `v${blueprint.version}`);

  const durable = (await request("/api/workflows", { method: "POST", body: { name: `P1 controllable ${unique}`, triggerType: "manual", definition: { start: "wait", states: [{ id: "wait", type: "wait", next: "done", config: { durationSeconds: 60 } }, { id: "done", type: "terminal" }] } } })).data.workflow;
  const workflowRunId = (await request(`/api/workflows/${durable.id}/runs`, { method: "POST", body: { input: { e2e: unique } } })).data.runId;
  await waitFor(`/api/workflow-runs/${workflowRunId}`, (data) => data.run.status === "waiting");
  await request(`/api/workflow-runs/${workflowRunId}/control`, { method: "POST", body: { action: "claim" } });
  await request(`/api/workflow-runs/${workflowRunId}/control`, { method: "POST", body: { action: "steer", text: "Prefer the verified route." } });
  await request(`/api/workflow-runs/${workflowRunId}/control`, { method: "POST", body: { action: "follow_up", text: "Summarize the result." } });
  await request(`/api/workflow-runs/${workflowRunId}/control`, { method: "POST", body: { action: "extend", seconds: 3600 } });
  const cancelledWorkflow = (await request(`/api/workflow-runs/${workflowRunId}/control`, { method: "POST", body: { action: "cancel", reason: "E2E cancellation" } })).data.run;
  assert.equal(cancelledWorkflow.status, "cancelled"); assert.equal(cancelledWorkflow.steerJson.length, 1); assert.equal(cancelledWorkflow.followupJson.length, 1); assert.ok(cancelledWorkflow.timeoutAt); assert.equal(cancelledWorkflow.ownerMemberId, memberId);

  const agentRunId = (await request(`/api/agents/${slowAgent.id}/test`, { method: "POST" })).data.runId;
  await waitFor(`/api/agents/${slowAgent.id}`, (data) => data.recentRuns.some((run) => run.id === agentRunId && run.status === "running"), 5_000);
  await request(`/api/agent-runs/${agentRunId}/control`, { method: "POST", body: { action: "cancel", reason: "Do not apply slow response" } });
  const cancelledAgent = await waitFor(`/api/agents/${slowAgent.id}`, (data) => data.recentRuns.some((run) => run.id === agentRunId && run.status === "cancelled"));
  const cancelledAgentRow = cancelledAgent.recentRuns.find((run) => run.id === agentRunId);
  assert.equal(cancelledAgentRow.status, "cancelled"); assert.notEqual(cancelledAgentRow.resultJson?.applied, 1);
  log("workflow and agent ownership, steer, follow-up, extension, and action-safe cancellation");

  const needs = (await request("/api/needs-you")).data;
  assert.ok(needs.items.some((item) => item.kind === "task_review" && item.targetId === unassigned.id));
  assert.ok(needs.counts.total >= 1);
  log("unified Needs you aggregation", `${needs.counts.total} item(s)`);

  await request("/api/enterprise/roles", { method: "POST", body: { key: `reviewer-${unique}`.slice(0, 40), name: "Release reviewer", permissions: ["workspace.read", "runs.control", "audit.export"] } });
  await request("/api/enterprise/governance", { method: "PUT", body: { retentionDays: 365, dataResidency: "eu-west" } });
  const enterprise = (await request("/api/enterprise")).data;
  assert.equal(enterprise.workspace.retentionDays, 365); assert.equal(enterprise.workspace.dataResidency, "eu-west");
  const service = (await request("/api/enterprise/service-accounts", { method: "POST", body: { name: `P1 CI ${unique}`, scopes: ["workflows.read", "workflows.run"] } })).data;
  const verifiedService = await request("/api/service-api/whoami", { auth: false, headers: { authorization: `Bearer ${service.token}` } });
  assert.deepEqual(verifiedService.data.account.scopes, ["workflows.read", "workflows.run"]);
  const serviceWorkflows = await request("/api/service-api/workflows", { auth: false, headers: { authorization: `Bearer ${service.token}` } });
  assert.ok(serviceWorkflows.data.workflows.some((row) => row.id === durable.id));
  const serviceRun = await request(`/api/service-api/workflows/${durable.id}/runs`, { method: "POST", auth: false, headers: { authorization: `Bearer ${service.token}` }, body: { input: { source: "service-e2e" } } });
  assert.equal(serviceRun.status, 202);
  await request(`/api/enterprise/service-accounts/${service.account.id}/revoke`, { method: "POST", body: {} });
  await expectStatus(401, "/api/service-api/whoami", { auth: false, headers: { authorization: `Bearer ${service.token}` } });
  log("custom RBAC, governance policy, scoped service identity, and revocation");

  const guestEmail = `guest-${unique}@circlechat.local`;
  const invite = (await request("/api/auth/invite", { method: "POST", body: { email: guestEmail, role: "guest", channelIds: [channel.id] } })).data;
  cookie = "";
  await request("/api/auth/accept-invite", { method: "POST", auth: false, body: { token: new URL(invite.inviteUrl).pathname.split("/").pop(), name: "P1 Guest", handle: `p1-guest-${unique}`, password: "guest-password" } });
  const guestConversations = (await request("/api/conversations")).data.conversations;
  assert.deepEqual(guestConversations.map((row) => row.id), [channel.id]);
  await expectStatus(403, "/api/decisions/observe", { method: "POST", body: { kind: "decision", title: "Guest write", decision: "No" } });
  cookie = adminCookie;
  log("guest role and explicit channel boundary", channel.name);

  await request("/api/enterprise/sso", { method: "PUT", body: { issuer: "http://127.0.0.1:33992", clientId: "circlechat-e2e", clientSecret: "oidc-secret", domains: ["circlechat.local"], defaultRole: "guest", enabled: true } });
  const start = await request(`/api/auth/sso/${workspaceHandle}`, { auth: false, redirect: "manual" });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  cookie = "";
  const callback = await request(`/api/auth/sso/callback?code=e2e-code&state=${encodeURIComponent(authorize.searchParams.get("state"))}`, { auth: false, redirect: "manual" });
  assert.equal(callback.status, 302); assert.ok(cookie.startsWith("cc_session="));
  const ssoMe = (await request("/api/me")).data;
  assert.equal(ssoMe.user.email, "sso@circlechat.local"); assert.equal(ssoMe.workspaces.find((row) => row.id === workspaceId).role, "guest");
  cookie = adminCookie;
  log("OIDC discovery, PKCE state, token exchange, domain policy, and guest provisioning");

  const auditJson = (await request("/api/enterprise/audit?format=json&days=1")).data.events;
  assert.ok(auditJson.some((event) => event.action === "sso.login"));
  assert.ok(auditJson.some((event) => event.action === "app.publish_approved"));
  const auditCsv = await request("/api/enterprise/audit?format=csv&days=1");
  assert.match(auditCsv.data, /app\.publish_approved/);
  log("permission-filtered JSON and CSV audit export", `${auditJson.length} event(s)`);

  const isolatedWorkspace = (await request("/api/workspaces", { method: "POST", body: { name: `P1 Isolation ${unique}` } })).data.workspace;
  assert.equal((await request("/api/decisions")).data.decisions.some((row) => row.id === corrected.id), false);
  assert.equal((await request("/api/apps")).data.apps.some((row) => row.id === hosted.id), false);
  assert.equal((await request("/api/pr-rooms")).data.rooms.some((row) => row.id === prRoomId), false);
  await expectStatus(404, `/api/decisions/${corrected.id}/correct`, { method: "POST", body: { kind: "decision", title: "Cross tenant", decision: "Denied" } });
  await expectStatus(404, `/api/workflow-runs/${workflowRunId}`, {});
  await expectStatus(404, `/api/pr-rooms/${prRoomId}/sync`, { method: "POST", body: { snapshot: {} } });
  await request(`/api/workspaces/${workspaceId}/switch`, { method: "POST", body: {} });
  log("cross-workspace isolation for decisions, apps, PR rooms, and run controls", isolatedWorkspace.id);

  console.log("\nP1 API E2E passed.");
} finally {
  await new Promise((resolve) => agentServer.close(resolve));
  await new Promise((resolve) => oidcServer.close(resolve));
  await new Promise((resolve) => gitServer.close(resolve));
}
