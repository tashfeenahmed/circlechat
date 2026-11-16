// SPDX-License-Identifier: AGPL-3.0-only
// Hosting features: TLS proxy trust, first-boot seed file, data export, workspace delete,
// and the tools-only listener for agent containers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { startApp, setupOwner, mockAgent, agentReply, Client } from "./helpers.ts";
import { requestIsHttps, requestHost, applySeedFile, resolveListenAddress } from "../server/src/hosting.ts";
import { createAgentServer } from "../server/src/server.ts";
import { hashPassword } from "../server/src/crypto.ts";

const loginCookie = async (url: string, headers: Record<string, string>) => {
  const r = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: "tash@lumen.test", password: "correct horse battery" }),
  });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie") ?? "";
};

test("proxy trust: Secure cookies only when the proxy says https and trust is on", async () => {
  assert.equal(requestIsHttps("https://x/", () => undefined, false), true);
  assert.equal(requestIsHttps("http://x/", (n) => (n === "x-forwarded-proto" ? "https" : undefined), false), false);
  assert.equal(requestIsHttps("http://x/", (n) => (n === "x-forwarded-proto" ? "https, http" : undefined), true), true);
  assert.equal(requestHost("http://127.0.0.1:3100/", (n) => ({ host: "127.0.0.1:3100", "x-forwarded-host": "acme.circlechat.co" })[n], true), "acme.circlechat.co");
  assert.equal(requestHost("http://127.0.0.1:3100/", (n) => ({ host: "127.0.0.1:3100", "x-forwarded-host": "evil.test" })[n], false), "127.0.0.1:3100");

  const trusted = await startApp({ trustProxy: true });
  const plain = await startApp();
  try {
    await setupOwner(trusted);
    await setupOwner(plain);
    assert.match(await loginCookie(trusted.url, { "x-forwarded-proto": "https" }), /;\s*Secure/i);
    assert.doesNotMatch(await loginCookie(trusted.url, {}), /;\s*Secure/i, "plain http through a trusted proxy is not https");
    assert.doesNotMatch(await loginCookie(plain.url, { "x-forwarded-proto": "https" }), /;\s*Secure/i, "the header is ignored without trust");
  } finally {
    await trusted.close();
    await plain.close();
  }
});

test("seed file: owner, workspace, provider, agents and a chat on first boot, then deleted", async () => {
  const h = await startApp();
  const dir = mkdtempSync(join(tmpdir(), "cc-seed-"));
  try {
    const seedPath = join(dir, "seed.json");
    // the control plane sends only a hash of the password the owner chose
    writeFileSync(
      seedPath,
      JSON.stringify({
        workspace: "Acme",
        owner: { email: "Owner@Acme.test", name: "Ola", passwordHash: hashPassword("a long secret pw") },
        providers: [{ id: "starter", kind: "openai-compatible", baseUrl: "http://host.docker.internal:3001/v1", apiKey: "freellm-unified-key", models: ["auto"], label: "Starter models" }],
        agents: [
          { name: "Hermes", engine: "hermes", model: "starter:auto", roleTitle: "Assistant" },
          { name: "OpenClaw", engine: "openclaw", model: "starter:auto" },
        ],
        chat: "General",
        welcome: "Welcome to Acme.",
      }),
    );
    assert.equal(applySeedFile(h.app, seedPath), "applied");
    assert.equal(existsSync(seedPath), false, "the seed file is deleted after use");

    const c = new Client(h.url);
    assert.equal((await c.get("/api/state")).json.setupNeeded, false);
    assert.equal((await c.post("/api/login", { email: "owner@acme.test", password: "wrong one!" })).status, 401);
    const r = await c.post("/api/login", { email: "owner@acme.test", password: "a long secret pw" });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, "owner");
    assert.equal((await c.get("/api/state")).json.workspace, "Acme");
    const providers = (await c.get("/api/providers")).json.providers;
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, "starter");
    assert.equal(providers[0].hasKey, true);
    assert.equal(JSON.stringify(providers).includes("freellm-unified-key"), false, "keys never come back out");
    const agents = (await c.get("/api/agents")).json.agents;
    assert.deepEqual(agents.map((a: any) => [a.handle, a.engine, a.sandbox, a.model]).sort(), [
      ["hermes", "hermes", "docker", "starter:auto"],
      ["openclaw", "openclaw", "docker", "starter:auto"],
    ]);
    const chats = (await c.get("/api/chats")).json.chats;
    const general = chats.find((x: any) => x.name === "General");
    assert.ok(general, "a General chat with the owner and agents");
    const msgs = (await c.get(`/api/chats/${general.id}/messages`)).json.messages;
    // the first agent introduces itself and says what to do next, as an agent message
    const hello = msgs.find((m: any) => m.authorType === "agent" && m.meta?.onboarding);
    assert.ok(hello, "first agent says hello");
    assert.match(hello.body, /I'm Hermes, your first agent/);
    assert.match(hello.body, /mention one with @/, "with two agents it explains @mentions");
    assert.ok(!msgs.some((m: any) => m.body === "Welcome to Acme."), "no second, system welcome");

    // a second boot with a file left behind never touches the live workspace
    writeFileSync(seedPath, JSON.stringify({ owner: { email: "intruder@x.test", name: "X", password: "whatever123" } }));
    assert.equal(applySeedFile(h.app, seedPath), "skipped");
    assert.equal(existsSync(seedPath), false);
    assert.equal((await c.get("/api/users")).json.users.length, 1);

    // a plain-text password in the seed is refused unless hashed, and a junk hash is rejected
    const h2 = await startApp();
    try {
      writeFileSync(seedPath, JSON.stringify({ owner: { email: "a@b.test", name: "A", passwordHash: "plain" } }));
      assert.throws(() => applySeedFile(h2.app, seedPath), /scrypt/);
    } finally {
      await h2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test("export: the owner downloads everything as a tar.gz; others can't", async () => {
  const h = await startApp();
  const dir = mkdtempSync(join(tmpdir(), "cc-export-test-"));
  try {
    const c = await setupOwner(h);
    const pip = await mockAgent(c, "pip");
    const chat = (await c.post("/api/chats", { name: "Launch", agents: [pip.id] })).json.chat;
    const said = (await c.post(`/api/chats/${chat.id}/messages`, { body: "remember the launch is on friday" })).json.message;
    // a one-agent group answers without an @mention: wait for it so nothing runs after the test
    await agentReply(c, chat.id, pip.id, said.ts);
    writeFileSync(join(h.dir, "agents", pip.id, "home", "notes.md"), "agent notes");
    await c.put("/api/providers/openai", { kind: "openai", baseUrl: "", apiKey: "sk-secret-value-123", models: ["gpt-x"] });
    await c.post("/api/users", { email: "m@lumen.test", name: "Mo", role: "admin", password: "member password" });

    const r = await fetch(h.url + "/api/workspace/export", { headers: { cookie: c.cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/gzip");
    assert.match(r.headers.get("content-disposition") ?? "", /circlechat-export-\d{4}-\d\d-\d\d\.tar\.gz/);
    const file = join(dir, "x.tar.gz");
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    execFileSync("tar", ["-xzf", file, "-C", dir]);
    const root = join(dir, "circlechat-export");
    assert.deepEqual(readdirSync(root).sort(), ["README.txt", "agents", "circlechat.db", "workspace.json"]);
    const ws = JSON.parse(readFileSync(join(root, "workspace.json"), "utf8"));
    assert.equal(ws.workspace, "Lumen");
    assert.ok(ws.tables.messages.some((m: any) => m.body.includes("launch is on friday")));
    assert.equal(ws.tables.users.length, 2);
    const text = readFileSync(join(root, "workspace.json"), "utf8");
    assert.equal(text.includes("pass_hash"), false, "no password hashes");
    assert.equal(text.includes("sk-secret-value-123"), false, "no secret values");
    assert.equal(readFileSync(join(root, "agents", pip.id, "home", "notes.md"), "utf8"), "agent notes");

    const admin = new Client(h.url);
    await admin.post("/api/login", { email: "m@lumen.test", password: "member password" });
    assert.equal((await admin.get("/api/workspace/export")).status, 403, "only the owner");
    assert.equal((await admin.post("/api/workspace/delete", { confirm: "Lumen", password: "member password" })).status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test("delete: needs the name and password, then everything is gone and setup is open again", async () => {
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    const pip = await mockAgent(c, "pip");
    assert.equal((await c.post("/api/workspace/delete", { confirm: "Lumen", password: "nope nope" })).status, 403);
    assert.equal((await c.post("/api/workspace/delete", { confirm: "lumen", password: "correct horse battery" })).status, 400);
    assert.ok(existsSync(join(h.dir, "agents", pip.id)));
    const r = await c.post("/api/workspace/delete", { confirm: "Lumen", password: "correct horse battery" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(existsSync(join(h.dir, "agents", pip.id)), false, "agent folders removed");
    const fresh = new Client(h.url);
    const st = (await fresh.get("/api/state")).json;
    assert.equal(st.setupNeeded, true);
    assert.equal(st.workspace, "");
    assert.equal((await c.get("/api/agents")).status, 401, "old sessions are gone");
    for (const t of ["users", "agents", "chats", "messages", "secrets", "sessions"]) {
      assert.equal((h.app.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n, 0, `${t} is empty`);
    }
    // and the server still works
    assert.equal((await setupOwner(h)) instanceof Client, true);
  } finally {
    await h.close();
  }
});

test("agent listener serves tools only", async () => {
  const h = await startApp();
  const srv = createAgentServer(h.app);
  try {
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/api/state")).status, 404, "no API on the bridge address");
    assert.equal((await fetch(base + "/")).status, 404, "no web app either");
    const mcp = await fetch(base + "/mcp/not-a-real-token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.ok(mcp.status === 401 || mcp.status === 403 || mcp.status === 404, `unknown tokens are refused (${mcp.status})`);
    assert.equal(resolveListenAddress("10.1.2.3"), "10.1.2.3");
    assert.equal(resolveListenAddress("lo0") ?? resolveListenAddress("lo"), "127.0.0.1");
    assert.equal(resolveListenAddress("no-such-nic"), null);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    await h.close();
  }
});

test("cli: backup, export and set-password-hash work on a live data folder", async () => {
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    await mockAgent(c, "pip");
    const env = { ...process.env, CIRCLECHAT_DATA: h.dir, CIRCLECHAT_MASTER_KEY: (h.app.cfg as any).masterKey };
    const cli = join(import.meta.dirname, "..", "server", "src", "cli.ts");
    const backup = execFileSync("node", [cli, "backup"], { env });
    const list = execFileSync("tar", ["-tz"], { input: backup }).toString();
    assert.match(list, /circlechat\.db/);
    assert.match(list, /agents\//);
    assert.doesNotMatch(list, /master\.key/, "the vault key never goes into a backup");
    const exp = execFileSync("node", [cli, "export"], { env });
    assert.match(execFileSync("tar", ["-tz"], { input: exp }).toString(), /circlechat-export\/workspace\.json/);
    assert.deepEqual(JSON.parse(execFileSync("node", [cli, "state"], { env }).toString()), { users: 1, agents: 1, workspace: "Lumen" });
    const out = execFileSync("node", [cli, "set-password-hash", "TASH@lumen.test"], { env, input: hashPassword("a fresh password") + "\n" }).toString();
    assert.equal(out.trim(), "ok");
    assert.equal((await c.get("/api/me")).status, 401, "old sessions are signed out");
    assert.equal((await new Client(h.url).post("/api/login", { email: "tash@lumen.test", password: "a fresh password" })).status, 200);
    assert.throws(() => execFileSync("node", [cli, "set-password-hash", "tash@lumen.test"], { env, input: "plaintext", stdio: "pipe" }));
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- hosted: one-time sign-in and Settings > Hosting

import { setHosting, signSsoToken } from "../server/src/hosting.ts";
import { fakeServer } from "./helpers.ts";

const SECRET = "instance-secret-0123456789abcdef";
const sso = (h: any, p: Record<string, unknown>, secret = SECRET) => fetch(`${h.url}/sso?token=${encodeURIComponent(signSsoToken(secret, { i: "inst_1", e: "tash@lumen.test", x: Date.now() + 60_000, ...p } as any))}`, { redirect: "manual" });

test("hosted sign-in handoff: valid once, then refused when reused, expired, mis-signed or not for the owner", async () => {
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    await c.post("/api/users", { email: "m@lumen.test", name: "Mo", role: "admin", password: "member password" });
    // not hosted yet: every token is refused
    let r = await sso(h, {});
    assert.equal(r.headers.get("location"), "/?signin=expired");
    setHosting(h.app, { consoleUrl: "http://127.0.0.1:9", instanceId: "inst_1", secret: SECRET });
    assert.deepEqual((await new Client(h.url).get("/api/state")).json.hosted, { signInUrl: "http://127.0.0.1:9/login" });
    assert.equal(JSON.stringify((await c.get("/api/settings")).json).includes(SECRET), false);

    const tok = signSsoToken(SECRET, { i: "inst_1", e: "tash@lumen.test", x: Date.now() + 60_000 });
    r = await fetch(`${h.url}/sso?token=${encodeURIComponent(tok)}`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/");
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^cc_session=/, "a normal session");
    const me = await fetch(`${h.url}/api/me`, { headers: { cookie } });
    assert.equal((await me.json()).user.email, "tash@lumen.test");

    const again = await fetch(`${h.url}/sso?token=${encodeURIComponent(tok)}`, { redirect: "manual" });
    assert.equal(again.headers.get("location"), "/?signin=expired", "single use");
    assert.equal(again.headers.get("set-cookie"), null);
    for (const [why, res] of [
      ["expired", await sso(h, { x: Date.now() - 1 })],
      ["too far ahead (over 2 minutes)", await sso(h, { x: Date.now() + 10 * 60_000 })],
      ["wrong signature", await sso(h, {}, "not-the-secret-at-all-0000000000")],
      ["other workspace", await sso(h, { i: "inst_2" })],
      ["not the owner", await sso(h, { e: "m@lumen.test" })],
      ["unknown person", await sso(h, { e: "nobody@x.test" })],
    ] as const) {
      assert.equal(res.headers.get("location"), "/?signin=expired", why);
      assert.equal(res.headers.get("set-cookie"), null, why);
    }
    const junk = await fetch(`${h.url}/sso?token=garbage`, { redirect: "manual" });
    assert.equal(junk.headers.get("location"), "/?signin=expired");
  } finally {
    await h.close();
  }
});

test("hosted Settings > Hosting: owner/admin only, forwarded to the control plane with the secret added server side", async () => {
  const cp = await fakeServer((req) => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) return { status: 401, body: { error: "bad token" } };
    if (req.url === "/api/hosted/inst_1/") return { body: { workspace: "Lumen", plan: "hosted" } };
    if (req.url === "/api/hosted/inst_1/restart" && req.method === "POST") return { body: { ok: true } };
    if (req.url === "/api/hosted/inst_1/refused") return { status: 401, body: { error: "nope" } };
    return { status: 404, body: { error: "no" } };
  });
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    assert.equal((await c.get("/api/hosting/")).status, 404, "self-hosted: no Hosting");
    setHosting(h.app, { consoleUrl: cp.url, instanceId: "inst_1", secret: SECRET });
    const info = await c.get("/api/hosting/");
    assert.equal(info.status, 200);
    assert.deepEqual(info.json, { workspace: "Lumen", plan: "hosted" });
    assert.equal((await c.post("/api/hosting/restart", {})).json.ok, true);
    const refused = await c.get("/api/hosting/refused");
    assert.equal(refused.status, 502, "a refusal from the control plane is not this browser signing out");
    assert.equal((await c.get("/api/me")).status, 200, "still signed in");
    assert.equal(cp.calls.at(-1).headers.authorization, `Bearer ${SECRET}`);
    assert.equal((await c.post("/api/workspace/delete", { confirm: "Lumen", password: "correct horse battery" })).status, 400, "hosted delete goes through Hosting");
    await c.post("/api/users", { email: "b@lumen.test", name: "Bo", role: "builder", password: "builder password" });
    const b = new Client(h.url);
    await b.post("/api/login", { email: "b@lumen.test", password: "builder password" });
    assert.equal((await b.get("/api/hosting/")).status, 403, "builders and members can't");
    const calls = cp.calls.length;
    assert.equal((await b.post("/api/hosting/restart", {})).status, 403);
    assert.equal(cp.calls.length, calls, "nothing forwarded for them");
  } finally {
    await h.close();
    await cp.close();
  }
});

test("hosted credits: CircleChat models is built in (can't be edited or removed); Credits is owner/admin only via the proxy", async () => {
  const cp = await fakeServer((req) => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) return { status: 401, body: {} };
    if (req.url === "/api/hosted/inst_1/credits") return { body: { balanceEur: 1.5, low: true, empty: false, packs: [10, 25, 50] } };
    if (req.url === "/api/hosted/inst_1/credits/topup") return { body: { url: "https://checkout.stripe.test/x" } };
    return { status: 404, body: {} };
  });
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    await c.put("/api/providers/circlechat", { kind: "openai-compatible", baseUrl: "http://cp/llm/v1", apiKey: "ccc_token", models: ["standard"], label: "CircleChat models" });
    // self-hosted: just a provider like any other
    assert.equal((await c.get("/api/providers")).json.providers[0].builtin, false);
    setHosting(h.app, { consoleUrl: cp.url, instanceId: "inst_1", secret: SECRET });
    const p = (await c.get("/api/providers")).json.providers[0];
    assert.equal(p.builtin, true);
    assert.equal(JSON.stringify(p).includes("ccc_token"), false, "the credits token never reaches the browser");
    assert.equal((await c.del("/api/providers/circlechat")).status, 400);
    assert.equal((await c.put("/api/providers/circlechat", { kind: "openai-compatible", baseUrl: "http://evil", models: [] })).status, 400);
    assert.equal((await c.get("/api/providers")).json.providers[0].baseUrl, "http://cp/llm/v1", "unchanged");
    // own keys still work alongside
    assert.equal((await c.put("/api/providers/mine", { kind: "openai", baseUrl: "", apiKey: "sk-mine", models: ["gpt-x"] })).status, 200);
    assert.equal((await c.del("/api/providers/mine")).status, 200);

    assert.equal((await c.get("/api/hosting/credits")).json.balanceEur, 1.5);
    assert.equal((await c.post("/api/hosting/credits/topup", { pack: 10 })).json.url, "https://checkout.stripe.test/x");
    await c.post("/api/users", { email: "w@lumen.test", name: "Wu", role: "member", password: "member password" });
    const m = new Client(h.url);
    await m.post("/api/login", { email: "w@lumen.test", password: "member password" });
    assert.equal((await m.get("/api/hosting/credits")).status, 403, "members can't see or buy credits");
    assert.equal((await m.post("/api/hosting/credits/topup", { pack: 10 })).status, 403);
  } finally {
    await h.close();
    await cp.close();
  }
});
