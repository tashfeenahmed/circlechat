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
