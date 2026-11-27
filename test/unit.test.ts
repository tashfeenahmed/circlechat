// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword, Vault, hmac, safeEqual } from "../server/src/crypto.ts";
import { openDb } from "../server/src/db.ts";
import { appendToolCall, verifyChain, redact } from "../server/src/toollog.ts";
import { parseCron, cronMatches, matches, render } from "../server/src/triggers.ts";
import { mentions, looksSecret } from "../server/src/services.ts";
import { inspectAgentFolder } from "../server/src/importer.ts";
import { newMasterKey } from "../server/src/app.ts";

test("passwords hash and verify", () => {
  const h = hashPassword("hunter22 is long");
  assert.ok(verifyPassword("hunter22 is long", h));
  assert.ok(!verifyPassword("wrong", h));
  assert.ok(!verifyPassword("x", "garbage"));
});

test("vault seals and refuses tampered data", () => {
  const v = new Vault(newMasterKey());
  const box = v.seal("ghp_supersecrettoken");
  assert.notEqual(box.data, "ghp_supersecrettoken");
  assert.equal(v.open(box), "ghp_supersecrettoken");
  const bad = { ...box, data: box.data.slice(0, -2) + (box.data.endsWith("A") ? "BB" : "AA") };
  assert.throws(() => v.open(bad));
  assert.throws(() => new Vault("short"));
  const other = new Vault(newMasterKey());
  assert.throws(() => other.open(box));
});

test("hmac + constant-time compare", () => {
  assert.ok(safeEqual(hmac("s", "body"), hmac("s", "body")));
  assert.ok(!safeEqual(hmac("s", "body"), hmac("t", "body")));
  assert.ok(!safeEqual("a", "ab"));
});

test("tool log is a hash chain and detects tampering", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 5; i++) appendToolCall(db, { agentId: "a", tool: `t${i}`, args: { i }, status: "ok" });
  assert.deepEqual(verifyChain(db), { ok: true, count: 5 });
  db.prepare("UPDATE tool_calls SET result = 'edited' WHERE seq = 3").run();
  const v = verifyChain(db);
  assert.equal(v.ok, false);
  assert.ok(v.brokenAt);
});

test("log never stores credentials", () => {
  const s = redact('{"token":"abc123","authorization":"Bearer abcdefghijklmnop", "x":"ghp_' + "a".repeat(36) + '"} sk-' + "b".repeat(30));
  assert.ok(!s.includes("abc123"));
  assert.ok(!s.includes("abcdefghijklmnop"));
  assert.ok(!s.includes("ghp_aaaa"));
  assert.ok(!s.includes("bbbbbbbb"));
});

test("cron parsing and matching", () => {
  const c = parseCron("30 8 * * 1-5");
  assert.ok(cronMatches(c, new Date(2026, 10, 16, 8, 30))); // Monday
  assert.ok(!cronMatches(c, new Date(2026, 10, 15, 8, 30))); // Sunday
  assert.ok(!cronMatches(c, new Date(2026, 10, 16, 8, 31)));
  assert.ok(cronMatches(parseCron("*/15 * * * *"), new Date(2026, 0, 1, 3, 45)));
  assert.ok(cronMatches(parseCron("0 0 * * 7"), new Date(2026, 10, 15, 0, 0))); // 7 = Sunday
  assert.throws(() => parseCron("* * *"));
  assert.throws(() => parseCron("60 * * * *"));
  assert.throws(() => parseCron("*/0 * * * *"));
});

test("webhook filters and prompt templates", () => {
  const p = { event: "issues", action: "opened", issue: { number: 7, title: "Footer broken", labels: [{ name: "ui" }, { name: "bug" }] } };
  assert.ok(matches({ event: "issues", action: "opened" }, p));
  assert.ok(matches({ "issue.labels.*.name": "bug" }, p));
  assert.ok(!matches({ "issue.labels.*.name": "docs" }, p));
  assert.ok(!matches({ action: "closed" }, p));
  assert.equal(render("Fix #{{issue.number}}: {{issue.title}} {{missing}}", p), "Fix #7: Footer broken ");
});

test("mentions and secret detection", () => {
  assert.deepEqual(mentions("hey @Pip and @wren-2, not email a@b.com"), ["pip", "wren-2"]);
  assert.ok(looksSecret("my key is ghp_" + "x".repeat(30)));
  assert.ok(looksSecret("password: hunter2!"));
  assert.ok(!looksSecret("we launch at 00:01 PT"));
});

test("importer reads OpenClaw workspaces and Hermes homes", () => {
  const base = mkdtempSync(join(tmpdir(), "cc-imp-"));
  const oc = join(base, "oc");
  mkdirSync(join(oc, "skills", "launch-research"), { recursive: true });
  writeFileSync(join(oc, "IDENTITY.md"), "# Identity\n- **Name:** Clawdia\n");
  writeFileSync(join(oc, "SOUL.md"), "You are calm and precise.");
  writeFileSync(join(oc, "AGENTS.md"), "Always cite sources.");
  writeFileSync(join(oc, "MEMORY.md"), "# Memory\n- Tash likes short answers\n- Launch is on Tuesday\n");
  writeFileSync(join(oc, "skills", "launch-research", "SKILL.md"), "---\nname: launch-research\n---\nSteps");
  const a = inspectAgentFolder(oc);
  assert.equal(a.kind, "openclaw");
  assert.equal(a.name, "Clawdia");
  assert.match(a.instructions, /calm and precise[\s\S]*cite sources/);
  assert.deepEqual(a.memories, ["Tash likes short answers", "Launch is on Tuesday"]);
  assert.deepEqual(a.skills, ["launch-research"]);

  const he = join(base, "he", ".hermes");
  mkdirSync(join(he, "memories"), { recursive: true });
  writeFileSync(join(he, "config.yaml"), "model: x\n");
  writeFileSync(join(he, "SOUL.md"), "# Hermy\nFriendly helper.");
  writeFileSync(join(he, "memories", "MEMORY.md"), "- Uses Linear for issues\n");
  const b = inspectAgentFolder(join(base, "he"));
  assert.equal(b.kind, "hermes");
  assert.equal(b.name, "Hermy");
  assert.deepEqual(b.memories, ["Uses Linear for issues"]);
  assert.throws(() => inspectAgentFolder(base), /doesn't look like/);
});

test("engine memory floor: the setting can raise it, never lower it", async () => {
  const { sandboxMemory, memBytes, engineById } = await import("../server/src/agents/engines.ts");
  assert.equal(memBytes("2g"), 2 * 1024 ** 3);
  assert.equal(memBytes("512m"), 512 * 1024 ** 2);
  assert.equal(memBytes("nonsense"), 0);
  const oc = engineById("openclaw")!;
  assert.equal(sandboxMemory(oc, undefined), "4g");
  assert.equal(sandboxMemory(oc, "2g"), "4g");
  assert.equal(sandboxMemory(oc, "8g"), "8g");
  assert.equal(sandboxMemory(engineById("hermes")!, undefined), "2g");
});

test("app catalog: configs, auth headers, form bodies and no host tricks", async () => {
  const { APP_CATALOG, preset, presetConfig, connectionHeaders, formEncode } = await import("../server/src/apps.ts");
  assert.ok(APP_CATALOG.length >= 20);
  assert.equal(new Set(APP_CATALOG.map((p) => p.id)).size, APP_CATALOG.length, "ids are unique");
  // header auth
  const slack = presetConfig(preset("slack")!, {}, "xoxb-1");
  assert.equal(slack.baseUrl, "https://slack.com/api");
  assert.deepEqual(connectionHeaders(slack, "xoxb-1"), { Authorization: "Bearer xoxb-1" });
  // extra headers
  assert.equal(connectionHeaders(presetConfig(preset("notion")!, {}, "s"), "s")["Notion-Version"], "2022-06-28");
  // basic auth with a field in the user name and the host
  const zd = presetConfig(preset("zendesk")!, { subdomain: "acme", email: "a@acme.com" }, "tok");
  assert.equal(zd.baseUrl, "https://acme.zendesk.com/api/v2");
  assert.equal(connectionHeaders(zd, "tok").Authorization, "Basic " + Buffer.from("a@acme.com/token:tok").toString("base64"));
  // fields can't move the request to another host
  for (const bad of ["evil.com/x", "acme.zendesk.com#", "a b", "", "x@y"]) assert.throws(() => presetConfig(preset("zendesk")!, { subdomain: bad, email: "a@acme.com" }, "t"));
  assert.throws(() => presetConfig(preset("twilio")!, { sid: "AC123/../../x" }, "t"));
  // Mailchimp's data centre comes from the key
  assert.equal(presetConfig(preset("mailchimp")!, {}, "abc-us21").baseUrl, "https://us21.api.mailchimp.com/3.0");
  assert.throws(() => presetConfig(preset("mailchimp")!, {}, "abc"), /data centre/);
  // Stripe and Twilio take form bodies
  assert.equal(presetConfig(preset("stripe")!, {}, "rk").bodyFormat, "form");
  assert.equal(decodeURIComponent(formEncode({ email: "a@b.com", metadata: { order: 1 }, items: [{ price: "p_1" }] })), "email=a@b.com&metadata[order]=1&items[0][price]=p_1");
});

test("app catalog: the Test button reads each API's answer", async () => {
  const { preset, presetConfig, checkPreset } = await import("../server/src/apps.ts");
  const fake = (status: number, body: unknown, seen?: (url: string, init: any) => void) =>
    (async (url: any, init: any) => {
      seen?.(String(url), init);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  const slack = preset("slack")!;
  const cfg = presetConfig(slack, {}, "xoxb-1");
  let hit = "";
  assert.deepEqual(await checkPreset(slack, cfg, "xoxb-1", fake(200, { ok: true, user: "nova", team: "Neu" }, (u) => (hit = u))), { ok: true, detail: "Connected: nova in Neu" });
  assert.equal(hit, "https://slack.com/api/auth.test");
  assert.equal((await checkPreset(slack, cfg, "x", fake(200, { ok: false, error: "invalid_auth" }))).ok, false, "Slack's 200 + ok:false is a failure");
  const linear = preset("linear")!;
  let sent: any;
  const r = await checkPreset(linear, presetConfig(linear, {}, "lin_api_1"), "lin_api_1", fake(200, { data: { viewer: { name: "Tash" } } }, (_u, i) => (sent = i)));
  assert.deepEqual(r, { ok: true, detail: "Connected: Tash" });
  assert.equal(sent.headers.Authorization, "lin_api_1", "Linear takes the key with no Bearer");
  const resend = preset("resend")!;
  assert.equal((await checkPreset(resend, presetConfig(resend, {}, "re_1"), "re_1", fake(401, { name: "restricted_api_key" }))).ok, true, "a sending-only key is fine");
  const cf = preset("cloudflare")!;
  assert.match((await checkPreset(cf, presetConfig(cf, {}, "x"), "x", fake(400, { success: false, errors: [{ message: "Invalid format for Authorization header" }] }))).detail, /didn't accept/);
  const shop = preset("shopify")!;
  assert.match((await checkPreset(shop, presetConfig(shop, { shop: "nope" }, "x"), "x", fake(404, {}))).detail, /couldn't find that store/);
});

test("login limiter: per address and per account, sliding window", async () => {
  const { FailureLimiter } = await import("../server/src/api.ts");
  const l = new FailureLimiter({ ip: 3, acct: 2 }, 1000);
  const k = (ip: string, a: string) => [`ip:${ip}`, `acct:${a}`];
  l.fail(k("1.1.1.1", "a"), 0);
  assert.equal(l.blocked(k("1.1.1.1", "a"), 10), 0);
  l.fail(k("2.2.2.2", "a"), 10);
  assert.ok(l.blocked(k("3.3.3.3", "a"), 20) > 0, "one account from many addresses is still limited");
  assert.equal(l.blocked(k("3.3.3.3", "b"), 20), 0, "other accounts are fine");
  assert.equal(l.blocked(k("3.3.3.3", "a"), 1011), 0, "the window slides");
  l.clear("acct:a");
  l.fail(k("9.9.9.9", "x"), 2000); l.fail(k("9.9.9.9", "y"), 2001); l.fail(k("9.9.9.9", "z"), 2002);
  assert.ok(l.blocked(k("9.9.9.9", "new"), 2003) > 0, "one address guessing many accounts is limited");
});

test("model proxy: engines get a stand-in token, the proxy adds the real key and stays on the provider", async () => {
  const { ModelProxy } = await import("../server/src/agents/modelproxy.ts");
  const { ENGINES } = await import("../server/src/agents/engines.ts");
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const seen: any[] = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers["x-api-key"], body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const up = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const proxy = new ModelProxy();
  const front = createServer(async (req, res) => {
    if (!(await proxy.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(front.address() as any).port}`;
  try {
    const real = { id: "or", kind: "openai-compatible" as const, baseUrl: `${up}/api/v1`, apiKey: "sk-real-secret", models: ["m"] };
    const w = proxy.wrap("a_1", real, base);
    assert.notEqual(w.provider.apiKey, real.apiKey);
    assert.equal(w.provider.baseUrl, `${base}/llm/${w.token}/v1`);
    // a streamed chat call goes through with the real key and back unchanged
    const r = await fetch(`${w.provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${w.provider.apiKey}`, "content-type": "application/json" }, body: '{"model":"m"}' });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "data: one\n\ndata: [DONE]\n\n");
    assert.deepEqual(seen.at(-1), { url: "/api/v1/chat/completions", auth: "Bearer sk-real-secret", xkey: undefined, body: '{"model":"m"}' });
    // Anthropic: x-api-key, and the SDK's own /v1 prefix is kept
    const an = proxy.wrap("a_1", { id: "an", kind: "anthropic", baseUrl: up, apiKey: "sk-ant-real", models: [] }, base);
    await fetch(`${an.provider.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": an.provider.apiKey }, body: "{}" });
    assert.equal(seen.at(-1).url, "/v1/messages");
    assert.equal(seen.at(-1).xkey, "sk-ant-real");
    // the path can't leave the provider
    assert.throws(() => proxy.upstream(real, "v1", "/../../etc"), /bad path/);
    assert.equal(new URL(proxy.upstream(real, "v1", "/@evil.example.com/x")).host, new URL(up).host, "an @ in the path stays on the provider");
    // a revoked or unknown token gets nothing
    proxy.revokeAgent("a_1");
    assert.equal((await fetch(`${w.provider.baseUrl}/chat/completions`, { method: "POST", body: "{}" })).status, 401);
    // engine config written to the agent's home holds the stand-in token, never the key
    const home = mkdtempSync(join(tmpdir(), "cc-eng-"));
    const w2 = proxy.wrap("a_2", real, base);
    for (const id of ["hermes", "openclaw", "opencode", "goose", "codex"]) {
      const e = ENGINES.find((x) => x.id === id)!;
      const spec = e.launch({ agentId: "a_2", handle: "pip", home, work: join(home, "work"), model: "m", provider: w2.provider, sandbox: "docker" });
      assert.ok(!JSON.stringify(spec.env).includes("sk-real-secret"), `${id} env`);
    }
    for (const f of [".hermes/config.yaml", ".hermes/.env", ".openclaw/openclaw.json", ".config/opencode/opencode.json"])
      assert.ok(!readFileSync(join(home, f), "utf8").includes("sk-real-secret"), f);
    assert.match(readFileSync(join(home, ".hermes/config.yaml"), "utf8"), /\/llm\/ccm_/);
  } finally {
    front.close();
    upstream.close();
  }
});

test("engine config is never written through a link the agent planted in its home", async () => {
  const { ENGINES, agentDirs } = await import("../server/src/agents/engines.ts");
  const { symlinkSync, writeFileSync, readFileSync, lstatSync, statSync } = await import("node:fs");
  const data = mkdtempSync(join(tmpdir(), "cc-home-"));
  const outside = join(data, "master.key");
  writeFileSync(outside, "VAULT KEY\n");
  const { home, work } = agentDirs(data, "a_x");
  assert.equal(statSync(home).mode & 0o777, 0o700, "home is private");
  const hermes = ENGINES.find((e) => e.id === "hermes")!;
  const opencode = ENGINES.find((e) => e.id === "opencode")!;
  const ctx = { agentId: "a_x", handle: "x", home, work, model: "m", sandbox: "docker" as const, provider: { id: "p", kind: "openai-compatible" as const, baseUrl: "http://x/v1", apiKey: "t", models: ["m"] } };
  // a file swapped for a link
  mkdirSync(join(home, ".hermes"), { recursive: true });
  symlinkSync(outside, join(home, ".hermes", "config.yaml"));
  hermes.launch(ctx);
  assert.equal(readFileSync(outside, "utf8"), "VAULT KEY\n", "target untouched");
  assert.ok(!lstatSync(join(home, ".hermes", "config.yaml")).isSymbolicLink(), "the link was replaced by a real file");
  // a whole folder swapped for a link
  const elsewhere = mkdtempSync(join(tmpdir(), "cc-elsewhere-"));
  mkdirSync(join(home, ".config"), { recursive: true });
  symlinkSync(elsewhere, join(home, ".config", "opencode"));
  opencode.launch(ctx);
  assert.throws(() => readFileSync(join(elsewhere, "opencode.json")), "nothing written through the folder link");
  assert.ok(lstatSync(join(home, ".config", "opencode")).isDirectory());
});

test("agent network limits: settings, docker arguments, and the filter's allow rules", async () => {
  const { egressConfigFromEnv, egressDockerArgs } = await import("../server/src/agents/egress.ts");
  assert.deepEqual(egressConfigFromEnv({}), { mode: "open", allow: [] });
  assert.deepEqual(egressConfigFromEnv({ CIRCLECHAT_AGENT_EGRESS: "none", CIRCLECHAT_AGENT_EGRESS_ALLOW: "github.com" }), { mode: "none", allow: [] });
  assert.deepEqual(egressConfigFromEnv({ CIRCLECHAT_AGENT_EGRESS: "allowlist", CIRCLECHAT_AGENT_EGRESS_ALLOW: "GitHub.com, *.npmjs.org" }).allow, ["github.com", "*.npmjs.org"]);
  assert.throws(() => egressConfigFromEnv({ CIRCLECHAT_AGENT_EGRESS: "allowlist" }), /needs CIRCLECHAT_AGENT_EGRESS_ALLOW/);
  assert.throws(() => egressConfigFromEnv({ CIRCLECHAT_AGENT_EGRESS: "allowlist", CIRCLECHAT_AGENT_EGRESS_ALLOW: "evil.com/x" }), /isn't a host name/);
  assert.deepEqual(egressDockerArgs(null), []);
  const args = egressDockerArgs({ network: "cc-agents-x", proxyUrl: "http://egress:3128" }).join(" ");
  assert.match(args, /--network cc-agents-x --dns 127\.0\.0\.1/);
  assert.match(args, /HTTPS_PROXY=http:\/\/egress:3128/);

  // the filter itself, run for real: CircleChat's own address always, listed hosts on 80/443 only
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const target = createServer((_q, r) => r.end("hello from circlechat")).listen(0, "127.0.0.1");
  await new Promise((r) => target.once("listening", r));
  const tport = (target.address() as any).port;
  const pport = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [join(import.meta.dirname, "..", "egress", "proxy.mjs")], { env: { PORT: String(pport), ALWAYS: `127.0.0.1:${tport}`, ALLOW: "*.example.com" }, stdio: "pipe" });
  await new Promise((r) => proc.stdout.once("data", r));
  const viaProxy = (url: string) =>
    new Promise<number>((resolve) => {
      const u = new URL(url);
      import("node:http").then(({ request }) =>
        request({ host: "127.0.0.1", port: pport, path: url, headers: { host: u.host } }, (r) => (r.resume(), resolve(r.statusCode!))).on("error", () => resolve(0)).end(),
      );
    });
  const connect = (hostport: string) =>
    new Promise<number>((resolve) => {
      import("node:http").then(({ request }) =>
        request({ host: "127.0.0.1", port: pport, method: "CONNECT", path: hostport })
          .on("connect", (r, sock) => (sock.destroy(), resolve(r.statusCode!)))
          .on("response", (r) => resolve(r.statusCode!))
          .on("error", () => resolve(0))
          .end(),
      );
    });
  try {
    assert.equal(await viaProxy(`http://127.0.0.1:${tport}/mcp/x`), 200, "CircleChat itself");
    assert.equal(await viaProxy(`http://127.0.0.1:${tport + 1}/`), 403, "another port on the same host");
    assert.equal(await viaProxy("http://evil.test/"), 403, "a host not on the list");
    assert.equal(await connect("evil.test:443"), 403);
    assert.equal(await connect("www.example.com:22"), 403, "listed host, wrong port");
    assert.equal(await connect("example.com.evil.test:443"), 403, "suffix trick");
  } finally {
    proc.kill();
    target.close();
  }
});

test("a tool call written as text is spotted; example code for a person is not", async () => {
  const { looksLikeTextToolCall: t } = await import("../server/src/agents/textcall.ts");
  // written-out calls
  assert.ok(t('<tool_call>\n{"name": "remember", "arguments": {"text": "x"}}\n</tool_call>'));
  assert.ok(t("Let me look.\n\n<actions>\n<function=mcp__docs__lookup>\n<parameter=slugs>\n[\"a\"]\n</parameter>"));
  assert.ok(t('<function_calls><invoke name="search"><parameter name="q">x</parameter></invoke></function_calls>'));
  assert.ok(t('[TOOL_CALLS] [{"name": "search", "arguments": {"q": "x"}}]'));
  assert.ok(t('{"name": "remember", "arguments": {"text": "launch is Tuesday"}}'));
  assert.ok(t('```json\n{"name": "github_list_issues", "parameters": {"repo": "a/b"}}\n```'));
  assert.ok(t('I will save that now.\n\n{"name": "remember", "input": {"text": "x"}}'));
  // real answers
  assert.ok(!t("Done. I saved it to team memory."));
  assert.ok(!t('Here is the payload format:\n\n```json\n{"name": "remember", "arguments": {"text": "x"}}\n```\n\nSend that to the API.'));
  assert.ok(!t('Use `<tool_call>` tags in Hermes configs, inside code:\n\n```\n<tool_call>{}</tool_call>\n```'));
  assert.ok(!t('{"plan": "launch", "owner": "maya"}'));
  assert.ok(!t(""));
});

test("head script: off by default, injected only when the operator sets one", async () => {
  const { loadHeadScript, withHeadScript } = await import("../server/src/server.ts");
  assert.equal(loadHeadScript(undefined), null);
  assert.equal(loadHeadScript(join(tmpdir(), "no-such-head-script.js")), null);
  const dir = mkdtempSync(join(tmpdir(), "cc-head-"));
  writeFileSync(join(dir, "head.js"), "window.x = 1;");
  assert.equal(String(loadHeadScript(join(dir, "head.js"))), "window.x = 1;");
  const html = String(withHeadScript(Buffer.from("<html><head><title>t</title></head><body></body></html>")));
  assert.match(html, /<script defer src="\/head\.js"><\/script>\n<\/head>/);
});

test("the open-source app ships no telemetry", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const root = join(import.meta.dirname, "..");
  for (const f of ["web/index.html", "desktop/main.cjs"]) {
    assert.doesNotMatch(readFileSync(join(root, f), "utf8"), /neu\.so|openpanel|glitchtip|sentry_key/i, f);
  }
  assert.equal(existsSync(join(root, "web/public/monitoring.js")), false);
});
