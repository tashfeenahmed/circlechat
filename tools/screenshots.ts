// SPDX-License-Identifier: AGPL-3.0-only
// README screenshots: a throwaway workspace with demo agents (mock engine, no
// models, no Docker), a realistic group chat, then Chrome takes the pictures.
//   npm run build && node tools/screenshots.ts [outDir]
// Writes chat, plan, tasks, memory, needs, apps, engines and add-agent PNGs (default: docs/screenshots).
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { startApp, Client, waitFor } from "../test/helpers.ts";
import { id } from "../server/src/crypto.ts";

const OUT = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "docs", "screenshots"));
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

const h = await startApp({ approvalTtlMs: 10 * 60_000 });
const c = new Client(h.url);
await c.post("/api/setup", { workspace: "Lumen", name: "Maya", email: "maya@lumen.test", password: "screenshots only" });
await c.post("/api/login", { email: "maya@lumen.test", password: "screenshots only" });

await c.put("/api/providers/openrouter", { kind: "openai-compatible", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "demo", models: ["anthropic/claude-haiku-5.5"] });
const agent = async (name: string, roleTitle: string, style: string, colour: string) =>
  (await c.post("/api/agents", { name, handle: name.toLowerCase(), roleTitle, style, colour, engine: "mock", sandbox: "local", autonomy: "act" })).json.agent;
const wren = await agent("Wren", "Writer", "leafy", "butter");
const milo = await agent("Milo", "Engineer", "classic", "sky");
const pip = await agent("Pip", "Research", "twin", "mint");
const juno = await agent("Juno", "Planner", "curly", "coral");

const launch = (await c.post("/api/chats", { name: "Launch", agents: [wren.id, milo.id, pip.id, juno.id] })).json.chat;
await c.post("/api/chats", { dmAgent: pip.id });
await c.post("/api/chats", { name: "Support", agents: [juno.id] });

// the conversation, written straight into the database with times a few minutes apart
const me = (await c.get("/api/me")).json.user;
const day = new Date();
day.setHours(9, 2, 0, 0);
let t = day.getTime();
const say = (chatId: string, who: { type: "user" | "agent"; id: string }, body: string, gapMin = 2) => {
  t += gapMin * 60_000;
  h.app.db
    .prepare("INSERT INTO messages(id, chat_id, author_type, author_id, kind, body, meta, ts) VALUES(?,?,?,?, 'text', ?, '{}', ?)")
    .run(id("m_"), chatId, who.type, who.id, body, t);
};
const U = { type: "user" as const, id: me.id };
const A = (a: any) => ({ type: "agent" as const, id: a.id });
say(launch.id, U, "@all launch is Tuesday. What's left on your side?");
say(launch.id, A(pip), "Three things from me:\n\n- **Competitor scan:** done, notes are in team memory\n- **Pricing page:** both plans read well\n- **Open question:** do we name the engines on the site?", 1);
say(launch.id, A(milo), "Signup bug is fixed and tested. PR #212 is up for review.", 1);
say(launch.id, A(wren), "Draft for the post on X, short and plain:\n\n> Your agents can finally share a group chat. CircleChat runs Hermes, OpenClaw and Claude Code on your own server, and they ask before anything risky.", 1);
const supportChat = (await c.get("/api/chats")).json.chats.find((x: any) => x.name === "Support");
const pipDm = (await c.get("/api/chats")).json.chats.find((x: any) => x.kind === "dm");
t = day.getTime() - 50 * 60_000;
say(pipDm.id, U, "Can you find the three best launch posts from last month?", 0);
say(pipDm.id, A(pip), "Here they are, with what made each one work. I saved them to memory too.", 1);
say(supportChat.id, A(juno), "Two new tickets, both about sign-in. I replied to one and need you for the other.", 5);
t = day.getTime() + 9 * 60_000;
h.app.db.prepare("UPDATE chats SET created_at = ?").run(day.getTime() - 3 * 3600_000);

// an "ask first" tool call, so the chat shows a real approval card
const x = (await c.post("/api/connections", { app: "http", name: "X", baseUrl: "https://api.x.com", identity: "agent", secret: "demo" })).json.connection;
await c.put(`/api/connections/${x.id}/grants`, { grants: [{ type: "workspace" }] });
const trigger = (await c.post(`/api/chats/${launch.id}/messages`, { body: '@wren\n!tool x_post {"path":"/2/tweets","body":{"text":"Your agents can finally share a group chat."}}' })).json.message;
await waitFor(async () => (await c.get("/api/approvals?state=pending")).json.approvals.length > 0, "approval card", 15_000);
// hide the instruction that made the mock agent ask
h.app.db.prepare("DELETE FROM messages WHERE id = ?").run(trigger.id);
h.app.db.prepare("UPDATE messages SET ts = ? WHERE chat_id = ? AND kind = 'approval'").run(t + 60_000, launch.id);
h.app.db.prepare("UPDATE approvals SET created_at = ?").run(t + 60_000);

// a plan with tasks and some team memory, made by Juno through the real tools
const junoDm = (await c.post("/api/chats", { dmAgent: juno.id })).json.chat;
const plan = {
  title: "Launch on Tuesday",
  steps: [
    { title: "Review the signup fix", assignee: "milo" },
    { title: "Post the launch thread on X", assignee: "wren" },
    { title: "Write the changelog", assignee: "juno" },
    { title: "Email the beta customers", assignee: "wren" },
    { title: "Check competitor launches", assignee: "pip" },
  ],
};
const memories = [
  "Launch is Tuesday at 09:00 CET",
  "Pricing: Hosted is 29 euros a month, Hosted Plus is 79",
  "Brand voice: plain words, short sentences, no hype",
  "Support replies within one working day",
];
const tools = [`!tool propose_plan ${JSON.stringify(plan)}`, ...memories.map((m) => `!tool remember ${JSON.stringify({ text: m, scope: "team" })}`)].join("\n");
const ask = (await c.post(`/api/chats/${junoDm.id}/messages`, { body: tools })).json.message;
await waitFor(async () => (await c.get("/api/tasks")).json.tasks?.length >= plan.steps.length, "plan tasks", 15_000);
await waitFor(async () => (await c.get(`/api/chats/${junoDm.id}/messages`)).json.messages.some((m: any) => m.authorType === "agent" && m.kind === "text" && m.ts > ask.ts), "juno's turn to end", 15_000);
// keep the plan card and memory pills, drop the instruction and the mock's tool report
h.app.db.prepare("DELETE FROM messages WHERE chat_id = ? AND kind = 'text'").run(junoDm.id);
say(junoDm.id, U, "Can you turn the launch into a plan and keep the key facts in memory?", 0);
h.app.db.prepare("UPDATE messages SET ts = ? WHERE chat_id = ? AND kind != 'text'").run(t + 30_000, junoDm.id);
say(junoDm.id, A(juno), "Done. Five tasks, one per owner, and four facts saved for the whole team. Milo's review is first.", 1);
h.app.db.prepare("UPDATE memories SET created_at = ?").run(t);
const st = ["done", "working", "checking", "todo", "needs_you"];
const taskRows = h.app.db.prepare("SELECT id FROM tasks ORDER BY created_at, rowid").all() as any[];
for (const [i, r] of taskRows.entries()) await c.patch(`/api/tasks/${r.id}`, { status: st[i % st.length] });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
await page.setCookie({ name: "cc_session", value: c.cookie.split("=")[1], url: h.url });
const shot = async (path: string, name: string, prep?: () => Promise<void>) => {
  await page.goto(h.url + path, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 700));
  await prep?.();
  await page.screenshot({ path: join(OUT, name) });
  console.log("wrote", join(OUT, name));
};
await shot(`/chats/${launch.id}`, "chat.png", async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
});
await shot("/settings/apps", "apps.png");
await shot(`/chats/${junoDm.id}`, "plan.png", async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
});
await shot("/tasks", "tasks.png");
await shot("/memory", "memory.png");
await shot("/needs", "needs.png");
await shot("/settings/engines", "engines.png");
await shot("/agents/new", "add-agent.png", async () => {
  await page.type('input[placeholder="Kit"]', "Biscuit");
  await page.type('input[placeholder="Sales"]', "Sales");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
});
await browser.close();
await h.close();
process.exit(0);
