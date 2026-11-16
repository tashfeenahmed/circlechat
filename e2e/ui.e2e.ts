// SPDX-License-Identifier: AGPL-3.0-only
// Browser end-to-end tests: real server + built web app + real ACP agent processes,
// driven through the installed Chrome. Run: npm run build && node --test e2e/ui.e2e.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { startApp, Client, waitFor, type Harness } from "../test/helpers.ts";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let h: Harness, browser: Browser, page: Page, api: Client;

const text = (p: Page) => p.evaluate(() => document.body.innerText);
const waitText = (p: Page, re: RegExp, what: string, ms = 20_000) => waitFor(async () => re.test(await text(p)), what, ms, 150);

before(async () => {
  h = await startApp({ approvalTtlMs: 60_000 });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--window-size=1440,960"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
});
after(async () => {
  await browser?.close();
  await h?.close();
});

test("first run: the owner sets up the workspace in the browser", async () => {
  await page.goto(h.url, { waitUntil: "networkidle0" });
  await page.waitForSelector("#ws");
  await page.type("#ws", "Lumen");
  await page.type("#nm", "Tash");
  await page.type("#em", "tash@lumen.test");
  await page.type("#pw", "correct horse battery");
  await page.click("button.btn.primary.lg");
  await waitText(page, /Chats/, "chats screen after setup");
  api = new Client(h.url);
  assert.equal((await api.post("/api/login", { email: "tash@lumen.test", password: "correct horse battery" })).status, 200);
});

test("talk to an agent and see its reply live", async () => {
  const pip = (await api.post("/api/agents", { name: "Pip", handle: "pip", engine: "mock", sandbox: "local", roleTitle: "Researcher", style: "twin", colour: "mint" })).json.agent;
  const chat = (await api.post("/api/chats", { dmAgent: pip.id })).json.chat;
  await page.goto(`${h.url}/chats/${chat.id}`, { waitUntil: "networkidle0" });
  const box = await page.waitForSelector('textarea[aria-label="Message"]');
  await box!.type("hello from the browser");
  await page.keyboard.press("Enter");
  await waitText(page, /pip got: hello from the browser/, "agent reply bubble");
  const img = await page.$('img[src*="avatars/set/twin-mint.png"]');
  assert.ok(img, "agent blob is shown");
});

test("plans and memory show as cards and pills", async () => {
  const chat = (await api.get("/api/chats")).json.chats.find((c: any) => c.kind === "dm");
  await page.goto(`${h.url}/chats/${chat.id}`, { waitUntil: "networkidle0" });
  const box = await page.waitForSelector('textarea[aria-label="Message"]');
  await box!.type('!tool propose_plan {"title":"Launch plan","steps":[{"title":"Find launches","assignee":"pip"}]}');
  await page.keyboard.press("Enter");
  await waitText(page, /Launch plan[\s\S]*Find launches/, "plan card");
  await box!.type('!tool remember {"text":"Launch is at 00:01 PT","scope":"team"}');
  await page.keyboard.press("Enter");
  await waitText(page, /Launch is at 00:01 PT/, "memory pill");
});

test("approve a risky action from the chat", async () => {
  const strict = (await api.post("/api/agents", { name: "Sage", handle: "sage", engine: "mock", sandbox: "local", autonomy: "ask", style: "halo", colour: "lilac" })).json.agent;
  const chat = (await api.post("/api/chats", { dmAgent: strict.id })).json.chat;
  await page.goto(`${h.url}/chats/${chat.id}`, { waitUntil: "networkidle0" });
  const box = await page.waitForSelector('textarea[aria-label="Message"]');
  await box!.type("!permission");
  await page.keyboard.press("Enter");
  await waitText(page, /Approve once/, "approval card");
  const [btn] = await page.$$("xpath/.//button[contains(., 'Approve once')]");
  await btn.click();
  await waitText(page, /permission: yes/, "agent continues after approval");
});

test("Needs you, Watch, Memory, Integrations, Settings all render", async () => {
  const pip = (await api.get("/api/agents")).json.agents.find((a: any) => a.handle === "pip");
  for (const [path, re] of [
    ["/needs", /Needs you/],
    [`/agents/${pip.id}/watch`, /pip got: hello from the browser|reading message/],
    ["/memory", /Launch is at 00:01 PT/],
    ["/settings/apps", /Apps/],
    ["/settings/log", /Tool log|Chain verified|verified/i],
    ["/settings/engines", /Engines/],
    ["/settings/models", /Models and keys/],
    ["/people", /Pip/],
  ] as const) {
    await page.goto(h.url + path, { waitUntil: "networkidle0" });
    await waitText(page, re, `screen ${path}`);
  }
  const html = await page.content();
  assert.ok(!/helper/i.test(await text(page)), "UI says agent, not helper");
  assert.ok(!html.includes("—"), "no em dashes in the UI");
});

test("signing out and back in", async () => {
  await page.goto(`${h.url}/settings`, { waitUntil: "networkidle0" });
  const [out] = await page.$$("xpath/.//button[contains(., 'Sign out')]");
  assert.ok(out, "sign out button");
  await out.click();
  await page.waitForSelector("#em", { timeout: 10_000 });
  await page.type("#em", "tash@lumen.test");
  await page.type("#pw", "correct horse battery");
  await page.click("button.btn.primary.lg");
  await waitText(page, /Chats/, "back in");
});
