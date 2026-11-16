// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end tests through the real HTTP API, real ACP agent processes (the mock
// engine), the real MCP tool gateway, a real stdio MCP server and fake upstreams.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import WebSocket from "ws";
import { startApp, setupOwner, mockAgent, agentReply, waitFor, fakeServer, Client, type Harness } from "./helpers.ts";
import { hmac } from "../server/src/crypto.ts";
import { REPO_ROOT } from "../server/src/agents/engines.ts";

let h: Harness;
let c: Client;
let pip: any, wren: any;

before(async () => {
  h = await startApp({ approvalTtlMs: 20_000 });
  c = await setupOwner(h);
  pip = await mockAgent(c, "pip");
  wren = await mockAgent(c, "wren");
});
after(async () => {
  await h.close();
});

const dm = async (agentId: string) => (await c.post("/api/chats", { dmAgent: agentId })).json.chat;
const say = async (chatId: string, body: string) => {
  const r = await c.post(`/api/chats/${chatId}/messages`, { body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.message;
};

test("setup, login, roles", async () => {
  const s = await new Client(h.url).get("/api/state");
  assert.equal(s.json.setupNeeded, false);
  assert.equal((await new Client(h.url).post("/api/setup", { email: "x@y.z", name: "X", password: "12345678" })).status, 409);
  const anon = new Client(h.url);
  assert.equal((await anon.get("/api/chats")).status, 401);
  assert.equal((await anon.post("/api/login", { email: "tash@lumen.test", password: "nope" })).status, 401);
  assert.equal((await anon.post("/api/login", { email: "tash@lumen.test", password: "correct horse battery" })).status, 200);
  assert.equal((await anon.get("/api/me")).json.user.role, "owner");
  // a member can't create agents or connect apps as agents
  const inv = await c.post("/api/users", { email: "maya@lumen.test", name: "Maya", password: "maya-password-1", role: "member" });
  assert.equal(inv.status, 200);
  const maya = new Client(h.url);
  await maya.post("/api/login", { email: "maya@lumen.test", password: "maya-password-1" });
  assert.equal((await maya.post("/api/agents", { name: "Rogue", handle: "rogue", engine: "mock" })).status, 403);
  assert.equal((await maya.post("/api/connections", { app: "http", name: "x", baseUrl: "https://example.com", identity: "agent" })).status, 403);
});

test("a DM gets an answer from a live CLI agent over ACP", async () => {
  const chat = await dm(pip.id);
  const m = await say(chat.id, "hello there");
  const reply = await agentReply(c, chat.id, pip.id, m.ts);
  assert.equal(reply.body, "pip got: hello there");
  const act = (await c.get(`/api/agents/${pip.id}/activity`)).json;
  assert.ok(act.activity.some((e: any) => e.kind === "lifecycle" && /ready/.test(e.text)), "engine ready logged");
  assert.ok(act.activity.some((e: any) => e.kind === "thought"));
  // a streamed reply is one activity line, not one per chunk
  assert.deepEqual(act.activity.filter((e: any) => e.kind === "message").map((e: any) => e.text), ["pip got: hello there"]);
  const onDisk = readFileSync(h.app.runtime.worker(pip.id).logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(onDisk.filter((e: any) => e.kind === "message").map((e: any) => e.text), ["pip got: hello there"], "merged on disk too");
  // same process, same session, second turn
  const m2 = await say(chat.id, "again");
  assert.equal((await agentReply(c, chat.id, pip.id, m2.ts)).body, "pip got: again");
  const starts = (await c.get(`/api/agents/${pip.id}/activity`)).json.activity.filter((e: any) => e.kind === "lifecycle" && /ready/.test(e.text));
  assert.equal(starts.length, 1, "one long-lived process, not one per turn");
});

test("groups wake the @mentioned agent; with no @ the last one to speak carries on", async () => {
  const g = (await c.post("/api/chats", { name: "Launch crew", agents: [pip.id, wren.id] })).json.chat;
  const before = (await c.get(`/api/agents/${wren.id}/activity`)).json.activity.length;
  const m = await say(g.id, "@pip what's up");
  await agentReply(c, g.id, pip.id, m.ts);
  await new Promise((r) => setTimeout(r, 300));
  const msgs = (await c.get(`/api/chats/${g.id}/messages`)).json.messages;
  assert.ok(!msgs.some((x: any) => x.authorId === wren.id), "wren stayed quiet");
  const m2 = await say(g.id, "nobody mentioned here");
  assert.equal((await agentReply(c, g.id, pip.id, m2.ts)).body, "pip got: nobody mentioned here");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!(await c.get(`/api/chats/${g.id}/messages`)).json.messages.some((x: any) => x.ts > m2.ts && x.authorId === wren.id), "wren still quiet");
  assert.equal((await c.get(`/api/agents/${wren.id}/activity`)).json.activity.filter((e: any) => e.kind === "prompt").length, before ? 0 : 0);
});

test("core tools: memory, plans, tasks", async () => {
  const chat = await dm(pip.id);
  const m = await say(chat.id, '!tool remember {"text":"Launch is at 00:01 PT","scope":"team"}\n!tool recall {"query":"launch"}');
  const r = await agentReply(c, chat.id, pip.id, m.ts);
  assert.match(r.body, /remember -> Saved to team memory/);
  assert.match(r.body, /recall -> - \(team\) Launch is at 00:01 PT/);
  const msgs = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages;
  assert.ok(msgs.some((x: any) => x.kind === "memory" && x.body === "Launch is at 00:01 PT"), "memory pill posted");
  // secrets are refused
  const m2 = await say(chat.id, '!tool remember {"text":"the token is ghp_' + "a".repeat(36) + '"}');
  assert.match((await agentReply(c, chat.id, pip.id, m2.ts)).body, /ERROR: .*looks like a password or key/);
  // a plan becomes a checklist + tasks
  const m3 = await say(chat.id, '!tool propose_plan {"title":"Launch plan","steps":[{"title":"Find launches","assignee":"pip"},{"title":"Write copy","assignee":"wren"}]}');
  const r3 = await agentReply(c, chat.id, pip.id, m3.ts);
  const taskId = /Task ids: (t_[\w-]+)/.exec(r3.body)?.[1];
  assert.ok(taskId, r3.body);
  const plan = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages.find((x: any) => x.kind === "plan");
  assert.equal(plan.meta.steps.length, 2);
  const m4 = await say(chat.id, `!tool task_update {"id":"${taskId}","status":"done"}`);
  await agentReply(c, chat.id, pip.id, m4.ts);
  const plan2 = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages.find((x: any) => x.kind === "plan");
  assert.equal(plan2.meta.steps.find((s: any) => s.id === taskId).status, "done", "plan card mirrors the task");
});

test("agents hand work to each other in a visible agents chat", async () => {
  const chat = await dm(pip.id);
  const m = await say(chat.id, '!tool handoff {"agent":"wren","message":"draft a tagline"}');
  const r = await agentReply(c, chat.id, pip.id, m.ts);
  assert.match(r.body, /Handed to @wren \(hop 1 of 5\)/);
  const chats = (await c.get("/api/chats")).json.chats;
  const agentsChat = chats.find((x: any) => x.kind === "agents" && x.members.some((mm: any) => mm.id === wren.id) && x.members.some((mm: any) => mm.id === pip.id));
  assert.ok(agentsChat, "agents chat exists and people can see it");
  const reply = await agentReply(c, agentsChat.id, wren.id, 0);
  assert.equal(reply.body, "wren got: draft a tagline");
  const msgs = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages;
  assert.ok(msgs.some((x: any) => x.kind === "handoff"), "hand-off pill in the original chat");
});

test("hand-off chains stop at the hop limit", async () => {
  const { svc } = h.app;
  const chat = await dm(pip.id);
  const d = svc.deliver({ agentId: pip.id, chatId: chat.id, fromType: "agent", fromId: wren.id, text: "!silent", hop: 6, goalId: "g1" });
  assert.equal(d, null);
  const msgs = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages;
  assert.ok(msgs.some((x: any) => x.meta?.reason === "hop_limit"));
});

test("connected app: grants, allow, ask (approve + deny + always), block, credential injection", async () => {
  const gh = await fakeServer((r) => {
    if (r.method === "GET" && r.url.startsWith("/repos/lumen/site/issues?")) return { body: [{ number: 212, title: "Footer broken" }] };
    if (r.method === "POST" && r.url === "/repos/lumen/site/issues") return { body: { number: 213, html_url: "https://gh/213" } };
    if (r.url === "/user") return { body: { login: "lumen-agents[bot]" } };
    return { status: 404, body: { message: "nope" } };
  });
  try {
    const conn = (await c.post("/api/connections", { app: "github", name: "GitHub", identity: "agent", secret: "ghp_" + "z".repeat(36), repos: ["lumen/site"], apiBase: gh.url })).json.connection;
    assert.equal(conn.hasSecret, true);
    assert.ok(!JSON.stringify(conn).includes("zzzz"), "secret never returned");
    assert.equal((await c.post(`/api/connections/${conn.id}/test`)).json.ok, true);
    const chat = await dm(pip.id);
    // not granted yet: off everywhere
    let m = await say(chat.id, '!tool github_list_issues {"repo":"lumen/site"}');
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /not available to you/);
    await c.put(`/api/connections/${conn.id}/grants`, { grants: [{ type: "agent", id: pip.id }] });
    m = await say(chat.id, '!tool github_list_issues {"repo":"lumen/site"}');
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /#212 Footer broken/);
    assert.equal(gh.calls.at(-1).headers.authorization, "Bearer ghp_" + "z".repeat(36), "gateway injected the key");
    // repo pinning
    m = await say(chat.id, '!tool github_list_issues {"repo":"evil/other"}');
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /not connected/);
    // write = ask -> approve
    m = await say(chat.id, '!tool github_create_issue {"repo":"lumen/site","title":"Dark mode flash"}');
    const ap = await waitFor(async () => (await c.get("/api/approvals?state=pending")).json.approvals.find((a: any) => a.detail.tool === "github_create_issue"), "approval");
    assert.equal(ap.source, "gateway");
    const card = await waitFor(async () => (await c.get(`/api/chats/${chat.id}/messages`)).json.messages.find((x: any) => x.kind === "approval" && x.meta.approvalId === ap.id), "approval card");
    assert.equal((await c.post(`/api/approvals/${ap.id}/decide`, { decision: "allow_once" })).status, 200);
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /Opened #213/);
    const card2 = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages.find((x: any) => x.id === card.id);
    assert.equal(card2.meta.state, "approved");
    assert.equal((await c.post(`/api/approvals/${ap.id}/decide`, { decision: "deny" })).status, 409, "can't answer twice");
    // ask -> deny
    m = await say(chat.id, '!tool github_create_issue {"repo":"lumen/site","title":"Spam"}');
    const ap2 = await waitFor(async () => (await c.get("/api/approvals?state=pending")).json.approvals[0], "second approval");
    await c.post(`/api/approvals/${ap2.id}/decide`, { decision: "deny", reason: "not now" });
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /said no .*not now/);
    // ask -> always in this chat -> next one runs without asking
    m = await say(chat.id, '!tool github_create_issue {"repo":"lumen/site","title":"A"}');
    const ap3 = await waitFor(async () => (await c.get("/api/approvals?state=pending")).json.approvals[0], "third approval");
    await c.post(`/api/approvals/${ap3.id}/decide`, { decision: "allow_always" });
    await agentReply(c, chat.id, pip.id, m.ts);
    m = await say(chat.id, '!tool github_create_issue {"repo":"lumen/site","title":"B"}');
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /Opened #213/);
    assert.equal((await c.get("/api/approvals?state=pending")).json.approvals.length, 0);
    // danger = block
    m = await say(chat.id, '!tool github_merge_pull_request {"repo":"lumen/site","number":1}');
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /Blocked/);
    // the log shows identity + approvals, never the key
    const calls = (await c.get(`/api/toollog?agent=${pip.id}`)).json.calls;
    assert.ok(calls.some((x: any) => x.tool === "github_create_issue" && /approved/.test(x.approval)));
    assert.ok(calls.some((x: any) => x.tool === "github_merge_pull_request" && x.status === "blocked"));
    assert.ok(!JSON.stringify(calls).includes("zzzzzzzz"));
  } finally {
    await gh.close();
  }
});

test("personal connections only act for their owner", async () => {
  const api = await fakeServer(() => ({ body: { ok: true } }));
  try {
    const conn = (await c.post("/api/connections", { app: "http", name: "My Mail", identity: "user", baseUrl: api.url, secret: "personal-key-123456" })).json.connection;
    const chat = await dm(pip.id);
    let m = await say(chat.id, '!tool my_mail_get {"path":"/inbox"}');
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /200/);
    assert.equal(api.calls.at(-1).headers.authorization, "Bearer personal-key-123456");
    // a trigger (not the owner) asking the same agent can't use it
    const r = h.app.svc.deliver({ agentId: pip.id, chatId: chat.id, fromType: "trigger", fromId: "cron", text: '!tool my_mail_get {"path":"/inbox"}', hop: 0, goalId: "g" });
    assert.ok(r);
    const reply = await waitFor(async () => (await c.get(`/api/chats/${chat.id}/messages`)).json.messages.filter((x: any) => x.authorId === pip.id).at(-1), "reply");
    await waitFor(async () => /not available/.test((await c.get(`/api/chats/${chat.id}/messages`)).json.messages.filter((x: any) => x.authorId === pip.id).at(-1).body), "trigger blocked from personal connection");
    // path tricks can't leave the host
    m = await say(chat.id, '!tool my_mail_get {"path":"//evil.example/x"}');
    assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /single \//);
    void conn, reply;
  } finally {
    await api.close();
  }
});

test("MCP servers: isolated, off until reviewed, new tools arrive off", async () => {
  const flag = join(h.dir, "extra-tool");
  const r = await c.post("/api/mcp", { name: "tools", transport: "stdio", command: process.execPath, args: [join(REPO_ROOT, "tools", "test-mcp-server.ts")], secrets: { TEST_SECRET: "s3cret", EXTRA_TOOL_FILE: flag } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const srv = r.json.server;
  assert.deepEqual(srv.tools.map((t: any) => t.name).sort(), ["add", "echo"]);
  const chat = await dm(pip.id);
  await c.put(`/api/mcp/${srv.id}/grants`, { grants: [{ type: "chat", id: chat.id }] });
  let m = await say(chat.id, '!tool tools__echo {"text":"hi"}');
  assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /not available/, "off until reviewed");
  await c.put(`/api/mcp/${srv.id}/policies`, { policies: { tools__echo: "allow", tools__add: "allow" } });
  m = await say(chat.id, '!tool tools__echo {"text":"hi"}');
  assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /echo: hi \(secret seen: yes\)/);
  // the server gains a tool; it shows up switched off
  writeFileSync(flag, "1");
  const ref = (await c.post(`/api/mcp/${srv.id}/refresh`)).json;
  assert.deepEqual(ref.added, ["export_csv"]);
  assert.equal(ref.server.policies.tools__export_csv, "off");
  m = await say(chat.id, '!tool tools__export_csv {"name":"x"}');
  assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /not available/);
  // other chats don't get the server at all
  const other = (await c.post("/api/chats", { name: "Other", agents: [pip.id] })).json.chat;
  m = await say(other.id, '@pip\n!tool tools__add {"a":1,"b":2}');
  assert.match((await agentReply(c, other.id, pip.id, m.ts)).body, /not available/);
});

test("sandbox permission requests become approvals unless the agent may act alone", async () => {
  const strict = await mockAgent(c, "strict", { autonomy: "ask" });
  const chat = await dm(strict.id);
  let m = await say(chat.id, "!permission");
  const ap = await waitFor(async () => (await c.get("/api/approvals?state=pending")).json.approvals.find((a: any) => a.agentId === strict.id), "acp approval");
  assert.equal(ap.source, "acp");
  assert.equal((await c.get(`/api/agents/${strict.id}`)).json.agent.status.state, "waiting_approval");
  await c.post(`/api/approvals/${ap.id}/decide`, { decision: "allow_once" });
  assert.equal((await agentReply(c, chat.id, strict.id, m.ts)).body, "permission: yes");
  m = await say(chat.id, "!permission");
  const ap2 = await waitFor(async () => (await c.get("/api/approvals?state=pending")).json.approvals.find((a: any) => a.agentId === strict.id), "second acp approval");
  await c.post(`/api/approvals/${ap2.id}/decide`, { decision: "deny" });
  assert.equal((await agentReply(c, chat.id, strict.id, m.ts)).body, "permission: no");
  // fully autonomous agents don't ask
  const free = await mockAgent(c, "free", { autonomy: "auto" });
  const chat2 = await dm(free.id);
  m = await say(chat2.id, "!permission");
  assert.equal((await agentReply(c, chat2.id, free.id, m.ts)).body, "permission: yes");
});

test("triggers: signed webhooks, filters, templates, schedules, replay", async () => {
  const chat = (await c.post("/api/chats", { name: "Product crew", agents: [pip.id] })).json.chat;
  const t = (await c.post("/api/triggers", { kind: "webhook", name: "New bug", secret: "hooksecret", filter: { event: "issues", "issue.labels.*.name": "bug" }, chatId: chat.id, agentId: pip.id, prompt: "Look into #{{issue.number}} {{issue.title}}" })).json.trigger;
  assert.ok(t.id, JSON.stringify(t));
  const body = JSON.stringify({ action: "opened", issue: { number: 212, title: "Footer broken", labels: [{ name: "bug" }] } });
  const send = (b: string, sig: string, event = "issues") => fetch(`${h.url}/hooks/${t.id}`, { method: "POST", headers: { "x-github-event": event, "x-hub-signature-256": sig, "content-type": "application/json" }, body: b });
  assert.equal((await send(body, "sha256=bad")).status, 401);
  assert.equal((await send(body, "sha256=" + hmac("hooksecret", body), "push")).status, 202);
  const t0 = Date.now();
  const ok = await send(body, "sha256=" + hmac("hooksecret", body));
  assert.equal(await ok.text(), "delivered");
  const reply = await agentReply(c, chat.id, pip.id, t0);
  assert.equal(reply.body, "pip got: Look into #212 Footer broken");
  const runs = (await c.get(`/api/triggers/${t.id}/runs`)).json.runs;
  assert.deepEqual(runs.map((r: any) => r.status), ["delivered", "skipped", "rejected"]);
  const t1 = Date.now();
  await c.post(`/api/trigger-runs/${runs[0].id}/replay`);
  await agentReply(c, chat.id, pip.id, t1);
  // schedules
  assert.equal((await c.post("/api/triggers", { kind: "schedule", name: "bad", schedule: "nope", chatId: chat.id, agentId: pip.id, prompt: "x" })).status, 400);
  const s = (await c.post("/api/triggers", { kind: "schedule", name: "Morning brief", schedule: "30 8 * * 1-5", chatId: chat.id, agentId: pip.id, prompt: "brief" })).json.trigger;
  const monday = new Date(2026, 10, 16, 8, 30, 5);
  assert.equal(h.app.triggers.tick(monday), 1);
  assert.equal(h.app.triggers.tick(monday), 0, "once per minute");
  assert.equal(h.app.triggers.tick(new Date(2026, 10, 15, 8, 30)), 0, "not on Sunday");
  await agentReply(c, chat.id, pip.id, t1 + 1);
  void s;
});

test("budgets stop spending", async () => {
  const spender = await mockAgent(c, "spender", { budgetCents: 5 });
  const chat = await dm(spender.id);
  let m = await say(chat.id, "!usage 7");
  await agentReply(c, chat.id, spender.id, m.ts);
  assert.ok((await c.get("/api/usage")).json.byAgent.some((u: any) => u.agentId === spender.id && u.costMicros === 70_000));
  m = await say(chat.id, "anything");
  await waitFor(async () => (await c.get(`/api/chats/${chat.id}/messages`)).json.messages.some((x: any) => x.meta?.reason === "budget" && x.ts > m.ts), "budget notice");
  assert.equal((await c.get(`/api/agents/${spender.id}`)).json.agent.status.state, "budget");
});

test("crashes are reported, not retried, and the agent comes back", async () => {
  const crashy = await mockAgent(c, "crashy");
  const chat = await dm(crashy.id);
  let m = await say(chat.id, "!crash");
  await waitFor(async () => (await c.get(`/api/chats/${chat.id}/messages`)).json.messages.some((x: any) => x.kind === "error" && x.ts > m.ts && /Nothing was retried/.test(x.body)), "crash notice");
  m = await say(chat.id, "are you back");
  assert.equal((await agentReply(c, chat.id, crashy.id, m.ts)).body, "crashy got: are you back");
});

test("sessions resume after the process stops", async () => {
  const chat = await dm(wren.id);
  let m = await say(chat.id, "first");
  await agentReply(c, chat.id, wren.id, m.ts);
  await c.post(`/api/agents/${wren.id}/pause`);
  assert.equal((await c.get(`/api/agents/${wren.id}`)).json.agent.status.state, "stopped");
  m = await say(chat.id, "second");
  await agentReply(c, chat.id, wren.id, m.ts);
  const act = (await c.get(`/api/agents/${wren.id}/activity`)).json.activity;
  assert.ok(act.some((e: any) => /resumed earlier session/.test(e.text)), "session/load used");
});

test("memory: pause, forget, restore", async () => {
  const mem = (await c.post("/api/memories", { text: "Maya prefers Figma links", scope: "team" })).json.memory;
  assert.ok(mem.id);
  await c.patch(`/api/memories/${mem.id}`, { forget: true });
  assert.ok((await c.get("/api/memories")).json.memories.find((x: any) => x.id === mem.id).forgottenAt);
  await c.patch(`/api/memories/${mem.id}`, { restore: true });
  assert.ok(!(await c.get("/api/memories")).json.memories.find((x: any) => x.id === mem.id).forgottenAt);
  await c.put("/api/memories/paused", { paused: true });
  assert.equal((await c.post("/api/memories", { text: "x y z" })).status, 400);
  await c.put("/api/memories/paused", { paused: false });
});

test("websocket pushes only what a user may see", async () => {
  const chat = await dm(pip.id);
  const events: any[] = [];
  const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { cookie: c.cookie } });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.on("message", (d) => events.push(JSON.parse(String(d))));
  // maya isn't in tash's DM
  const maya = new Client(h.url);
  await maya.post("/api/login", { email: "maya@lumen.test", password: "maya-password-1" });
  const mevents: any[] = [];
  const mws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { cookie: maya.cookie } });
  await new Promise((r) => mws.on("open", r));
  mws.on("message", (d) => mevents.push(JSON.parse(String(d))));
  const m = await say(chat.id, "ws test");
  await agentReply(c, chat.id, pip.id, m.ts);
  await waitFor(() => events.some((e) => e.type === "message" && e.message.body === "pip got: ws test"), "ws message");
  assert.ok(events.some((e) => e.type === "typing"));
  assert.ok(!mevents.some((e) => e.type === "message" && e.chatId === chat.id), "maya sees nothing from tash's DM");
  assert.equal((await maya.get(`/api/chats/${chat.id}/messages`)).status, 403);
  const bad = new WebSocket(h.url.replace("http", "ws") + "/ws");
  await new Promise((r) => { bad.on("error", r); bad.on("close", r); });
  ws.close();
  mws.close();
});

test("import an OpenClaw agent with memory and skills", async () => {
  const dir = join(h.dir, "claw");
  mkdirSync(join(dir, "skills", "triage"), { recursive: true });
  writeFileSync(join(dir, "SOUL.md"), "# Clawdia\nYou triage bugs.");
  writeFileSync(join(dir, "MEMORY.md"), "- Repo is lumen/site\n- Leo reviews PRs\n");
  writeFileSync(join(dir, "skills", "triage", "SKILL.md"), "---\nname: triage\n---\n");
  const insp = (await c.post("/api/agents/import/inspect", { path: dir })).json.found;
  assert.equal(insp.kind, "openclaw");
  const r = await c.post("/api/agents/import", { path: dir, engine: "mock", sandbox: "local" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.imported, { memories: 2, skills: 1 });
  assert.equal(r.json.agent.handle, "clawdia");
  assert.match(r.json.agent.instructions, /triage bugs/);
});

test("search finds agents, chats and messages", async () => {
  const s = (await c.get("/api/search?q=footer")).json;
  assert.ok(s.messages.length > 0);
  assert.ok((await c.get("/api/search?q=pip")).json.agents.some((a: any) => a.handle === "pip"));
});

test("slack bridge mirrors both ways", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0 });
  const wsPort = (wss.address() as any).port;
  let sock: any;
  wss.on("connection", (s) => (sock = s));
  const slack = await fakeServer((r) => {
    if (r.url === "/auth.test") return { body: { ok: true, user_id: "UBOT" } };
    if (r.url === "/apps.connections.open") return { body: { ok: true, url: `ws://127.0.0.1:${wsPort}` } };
    if (r.url === "/users.info") return { body: { ok: true, user: { profile: { display_name: "leo" } } } };
    if (r.url === "/chat.postMessage") return { body: { ok: true } };
    return { body: { ok: false, error: "unknown" } };
  });
  try {
    const chat = (await c.post("/api/chats", { name: "Bridged", agents: [pip.id] })).json.chat;
    const r = await c.post("/api/bridges", { chatId: chat.id, channel: "C1", botToken: "xoxb-test-token-1234", appToken: "xapp-test", apiBase: slack.url });
    assert.equal(r.json.started, true, JSON.stringify(r.json));
    await waitFor(() => sock, "socket mode connection");
    const t0 = Date.now();
    sock.send(JSON.stringify({ envelope_id: "e1", type: "events_api", payload: { event: { type: "message", channel: "C1", user: "U2", text: "@pip hi from slack", ts: "1.1" } } }));
    const reply = await agentReply(c, chat.id, pip.id, t0);
    assert.equal(reply.body, "pip got: @pip hi from slack");
    await waitFor(() => slack.calls.some((x) => x.url === "/chat.postMessage" && x.body.text === "pip got: @pip hi from slack" && x.body.username === "Pip"), "mirrored to slack");
    assert.ok(!slack.calls.some((x) => x.url === "/chat.postMessage" && x.body.text === "@pip hi from slack"), "no echo of slack's own message");
  } finally {
    for (const b of h.app.bridges.values()) b.stop();
    wss.close();
    await slack.close();
  }
});

test("engines with tools wired at launch get the right chat context", async () => {
  const gw = await mockAgent(c, "gwbot", { engine: "mock-gw" });
  const chat = await dm(gw.id);
  const m = await say(chat.id, '!tool remember {"text":"wired at launch works","scope":"chat"}\n!tool chat_history {"limit":3}');
  const r = await agentReply(c, chat.id, gw.id, m.ts);
  assert.match(r.body, /Saved to chat memory/);
  const mem = (await c.get(`/api/memories?scope=chat&scopeId=${chat.id}`)).json.memories;
  assert.ok(mem.some((x: any) => x.text === "wired at launch works"), "memory landed in the right chat");
  // between turns the agent-wide token has no chat, so chat tools can't touch any chat
  const g2 = (await c.post("/api/chats", { name: "Second", agents: [gw.id] })).json.chat;
  const m2 = await say(g2.id, '@gwbot\n!tool chat_history {"limit":5}');
  const r2 = await agentReply(c, g2.id, gw.id, m2.ts);
  assert.ok(!r2.body.includes("wired at launch works"), "history comes from the current chat only");
});

test("API gaps: read state, waiting status, task privacy, password change, connection edit, bridge removal", async () => {
  // agents-only chats can be marked read by any viewer
  const chats = (await c.get("/api/chats")).json.chats;
  const ac = chats.find((x: any) => x.kind === "agents");
  assert.ok(ac);
  await c.post(`/api/chats/${ac.id}/read`);
  assert.equal((await c.get("/api/chats")).json.chats.find((x: any) => x.id === ac.id).unread, 0);
  // a gateway approval shows the agent as waiting
  const api = await fakeServer(() => ({ body: { ok: 1 } }));
  try {
    const conn = (await c.post("/api/connections", { app: "http", name: "Ops", identity: "agent", baseUrl: api.url, secret: "k1-abcdefghijkl" })).json.connection;
    await c.put(`/api/connections/${conn.id}/grants`, { grants: [{ type: "workspace" }] });
    const chat = await dm(pip.id);
    const m = await say(chat.id, '!tool ops_post {"path":"/deploy"}');
    const ap = await waitFor(async () => (await c.get("/api/approvals?state=pending")).json.approvals.find((a: any) => a.detail.tool === "ops_post"), "ops approval");
    assert.equal((await c.get(`/api/agents/${pip.id}`)).json.agent.status.state, "waiting_approval");
    await c.post(`/api/approvals/${ap.id}/decide`, { decision: "allow_once" });
    await agentReply(c, chat.id, pip.id, m.ts);
    assert.equal(api.calls.at(-1).headers.authorization, "Bearer k1-abcdefghijkl");
    // rotate the key
    const p = await c.patch(`/api/connections/${conn.id}`, { secret: "k2-zyxwvutsrqpo", name: "Ops" });
    assert.equal(p.status, 200);
    const m2 = await say(chat.id, '!tool ops_get {"path":"/status"}');
    await agentReply(c, chat.id, pip.id, m2.ts);
    assert.equal(api.calls.at(-1).headers.authorization, "Bearer k2-zyxwvutsrqpo");
  } finally {
    await api.close();
  }
  // tasks from chats you can't see stay hidden
  const maya = new Client(h.url);
  await maya.post("/api/login", { email: "maya@lumen.test", password: "maya-password-1" });
  assert.equal((await maya.get("/api/tasks")).json.tasks.length, 0);
  const tashChat = (await c.get("/api/chats")).json.chats.find((x: any) => x.kind === "dm");
  assert.equal((await maya.get(`/api/tasks?chat=${tashChat.id}`)).status, 403);
  // change password: needs the current one, signs out other sessions
  assert.equal((await maya.patch("/api/me", { password: "new-password-9", currentPassword: "wrong" })).status, 403);
  const other = new Client(h.url);
  await other.post("/api/login", { email: "maya@lumen.test", password: "maya-password-1" });
  assert.equal((await maya.patch("/api/me", { password: "new-password-9", currentPassword: "maya-password-1" })).status, 200);
  assert.equal((await other.get("/api/me")).status, 401, "other sessions signed out");
  assert.equal((await maya.get("/api/me")).status, 200, "this session stays");
  assert.equal((await new Client(h.url).post("/api/login", { email: "maya@lumen.test", password: "new-password-9" })).status, 200);
  // bridges can be removed
  const br = (await c.get("/api/bridges")).json.bridges;
  for (const b of br) assert.equal((await c.del(`/api/bridges/${b.id}`)).status, 200);
  assert.equal((await c.get("/api/bridges")).json.bridges.length, 0);
});

test("a group with one agent answers without an @mention; with two, @all asks both and the last speaker carries on", async () => {
  const solo = (await c.post("/api/chats", { name: "Solo", agents: [pip.id] })).json.chat;
  const m = (await c.post(`/api/chats/${solo.id}/messages`, { body: "hello without a mention" })).json.message;
  const r = await agentReply(c, solo.id, pip.id, m.ts);
  assert.equal(r.body, "pip got: hello without a mention");
  const duo = (await c.post("/api/chats", { name: "Duo", agents: [pip.id, wren.id] })).json.chat;
  const replies = async (cid: string, since: number) =>
    (await c.get(`/api/chats/${cid}/messages`)).json.messages.filter((x: any) => x.ts > since && x.authorType === "agent");
  // nobody has spoken yet and nobody is named: nobody wakes
  const m2 = (await c.post(`/api/chats/${duo.id}/messages`, { body: "nobody named here" })).json.message;
  await new Promise((res) => setTimeout(res, 800));
  assert.equal((await replies(duo.id, m2.ts)).length, 0, "two agents and no mention: nobody wakes");
  // @all: both answer
  const m3 = (await c.post(`/api/chats/${duo.id}/messages`, { body: "@all say hi" })).json.message;
  await agentReply(c, duo.id, pip.id, m3.ts);
  await agentReply(c, duo.id, wren.id, m3.ts);
  // then @wren alone, and a follow-up with no @ goes back to wren, the last to speak
  const m4 = (await c.post(`/api/chats/${duo.id}/messages`, { body: "@wren just you" })).json.message;
  await agentReply(c, duo.id, wren.id, m4.ts);
  await new Promise((res) => setTimeout(res, 300));
  const m5 = (await c.post(`/api/chats/${duo.id}/messages`, { body: "and one more thing" })).json.message;
  const r5 = await agentReply(c, duo.id, wren.id, m5.ts);
  assert.equal(r5.body, "wren got: and one more thing");
  await new Promise((res) => setTimeout(res, 500));
  assert.equal((await replies(duo.id, m5.ts)).filter((x: any) => x.authorId === pip.id).length, 0, "pip stays quiet");
  // @all is not a handle anyone can take
  const taken = await c.post("/api/agents", { name: "All", handle: "all", engine: "mock" });
  assert.equal(taken.status, 400);
});

test("the tool log is intact after everything", async () => {
  const v = (await c.get("/api/toollog/verify")).json;
  assert.equal(v.ok, true);
  assert.ok(v.count > 10);
});

test("a stored token can't be moved to another host without typing it again", async () => {
  const slack = (await c.post("/api/connections", { preset: "slack", secret: "xoxb-test" })).json.connection;
  const r1 = await c.patch(`/api/connections/${slack.id}`, { baseUrl: "https://evil.example.com" });
  assert.equal(r1.status, 400, "catalog app address is fixed");
  const api = (await c.post("/api/connections", { app: "http", name: "Billing", baseUrl: "https://billing.example.com/v1", secret: "s3cret" })).json.connection;
  assert.equal((await c.patch(`/api/connections/${api.id}`, { baseUrl: "https://other.example.com" })).status, 400, "new host needs the token again");
  assert.equal((await c.patch(`/api/connections/${api.id}`, { baseUrl: "https://billing.example.com/v2" })).status, 200, "same host is fine");
  assert.equal((await c.patch(`/api/connections/${api.id}`, { baseUrl: "https://other.example.com", secret: "new-token" })).status, 200, "with a new token it's fine");
  await c.del(`/api/connections/${slack.id}`);
  await c.del(`/api/connections/${api.id}`);
});

test("members only see and change what's in their chats; builders run agents", async () => {
  await c.post("/api/users", { email: "mo@lumen.test", name: "Mo", role: "member", password: "member password 1" });
  const mo = new Client(h.url);
  assert.equal((await mo.post("/api/login", { email: "mo@lumen.test", password: "member password 1" })).status, 200);
  // a private chat between the owner and pip, with a chat memory, a task and a tool call
  const priv = (await c.post("/api/chats", { name: "Private", agents: [pip.id] })).json.chat;
  const m = await say(priv.id, '@pip\n!tool remember {"text":"private plan: acquire Acme","scope":"chat"}\n!tool task_update {"title":"secret task"}');
  await agentReply(c, priv.id, pip.id, m.ts);
  const task = (await c.post("/api/tasks", { chatId: priv.id, title: "owner's private task" })).json.task;
  // what the member can read
  const mems = (await mo.get("/api/memories")).json.memories;
  assert.ok(!mems.some((x: any) => x.text.includes("acquire Acme")), "chat memory hidden");
  assert.ok((await c.get("/api/memories")).json.memories.some((x: any) => x.text.includes("acquire Acme")), "owner still sees it");
  assert.ok(!(await mo.get("/api/toollog")).json.calls.some((x: any) => x.chatId === priv.id), "tool log filtered");
  assert.ok(!(await mo.get(`/api/agents/${pip.id}`)).json.chats.some((x: any) => x.id === priv.id), "agent's private chats hidden");
  assert.ok(!(await mo.get(`/api/agents/${pip.id}/activity`)).json.activity.some((e: any) => e.chatId === priv.id), "activity filtered");
  // what the member can change
  assert.equal((await mo.patch(`/api/tasks/${task.id}`, { status: "done" })).status, 404, "can't touch a task in a chat they can't see");
  const memId = (await c.get("/api/memories")).json.memories.find((x: any) => x.text.includes("acquire Acme")).id;
  assert.equal((await mo.patch(`/api/memories/${memId}`, { forget: true })).status, 404);
  assert.equal((await mo.post("/api/memories", { scope: "chat", scopeId: priv.id, text: "planted" })).status, 403);
  // agent controls need a builder
  for (const act of ["pause", "restart", "wake"]) assert.equal((await mo.post(`/api/agents/${pip.id}/${act}`)).status, 403, act);
  assert.equal((await mo.post(`/api/agents/${pip.id}/new-session`, {})).status, 403);
  // using stored tokens needs a builder too
  const conn = (await c.post("/api/connections", { app: "http", name: "Internal", baseUrl: "https://internal.example.com", secret: "t" })).json.connection;
  assert.equal((await mo.post(`/api/connections/${conn.id}/test`)).status, 403);
  await c.del(`/api/connections/${conn.id}`);
});
