// SPDX-License-Identifier: AGPL-3.0-only
// Real engine smoke test (not part of `npm test`: costs real model calls).
//   node test/real/real-engines.ts claude opencode hermes openclaw
// Env: LOCAL_MODEL_URL (OpenAI-compatible, e.g. the Mac mini Qwen), LOCAL_MODEL, SANDBOX=docker|local
import { startApp, setupOwner, agentReply, waitFor } from "../helpers.ts";

const which = process.argv.slice(2);
const url = process.env.LOCAL_MODEL_URL ?? "http://192.168.1.140:8080/v1";
const model = process.env.LOCAL_MODEL ?? "mlx-community/Qwen3.8-27B-4bit";
const results: { engine: string; check: string; ok: boolean; detail: string; ms: number }[] = [];

const docker = process.env.SANDBOX === "docker" || which.some((e) => e === "hermes" || e === "openclaw");
const h = await startApp({ turnTimeoutMs: 600_000, baseDir: docker ? new URL("../../.test-data", import.meta.url).pathname : undefined });
const c = await setupOwner(h);
h.app.upsertProvider({ id: "local", kind: "openai-compatible", baseUrl: url, apiKey: "", models: [model], label: "Mac mini Qwen" });
h.app.gateway.agentReachableUrl = h.url.replace("127.0.0.1", "host.docker.internal");

async function check(engine: string, name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ engine, check: name, ok: true, detail, ms: Date.now() - t });
  } catch (e) {
    results.push({ engine, check: name, ok: false, detail: (e as Error).message.slice(0, 400), ms: Date.now() - t });
  }
  console.log(JSON.stringify(results.at(-1)));
}

for (const engine of which) {
  const sandbox = engine === "claude" || engine === "opencode" ? process.env.SANDBOX ?? "local" : "docker";
  const r = await c.post("/api/agents", { name: `T-${engine}`, handle: `t${engine}`, engine, sandbox, model: engine === "claude" ? "" : model, roleTitle: "Tester", autonomy: "auto" });
  if (r.status !== 200) {
    results.push({ engine, check: "create", ok: false, detail: JSON.stringify(r.json), ms: 0 });
    continue;
  }
  const agent = r.json.agent;
  const chat = (await c.post("/api/chats", { dmAgent: agent.id })).json.chat;
  const ask = async (text: string) => {
    const m = (await c.post(`/api/chats/${chat.id}/messages`, { body: text })).json.message;
    return agentReply(c, chat.id, agent.id, m.ts, 600_000);
  };
  await check(engine, "replies in chat", async () => {
    const reply = await ask("Reply with just the single word: pong");
    if (!/pong/i.test(reply.body)) throw new Error("unexpected reply: " + reply.body);
    return reply.body.slice(0, 80);
  });
  await check(engine, "uses CircleChat tools (MCP gateway)", async () => {
    const fact = `The ${engine} test code is ${Math.random().toString(36).slice(2, 8)}`;
    const reply = await ask(`Use the circlechat "remember" tool to save this exact sentence to team memory: "${fact}". Then reply with the word done.`);
    await waitFor(async () => (await c.get("/api/memories")).json.memories.some((m: any) => m.text.includes(fact.split(" is ")[1])), "memory saved", 30_000);
    return `memory saved; reply: ${reply.body.slice(0, 60)}`;
  });
  await check(engine, "remembers within the session", async () => {
    await ask("My favourite number is 4471. Just reply OK.");
    const reply = await ask("What is my favourite number? Reply with just the number.");
    if (!reply.body.includes("4471")) throw new Error("got: " + reply.body);
    return reply.body.slice(0, 40);
  });
  const act = (await c.get(`/api/agents/${agent.id}/activity?limit=2000`)).json.activity;
  const starts = act.filter((e: any) => e.kind === "lifecycle" && /ready/.test(e.text)).length;
  results.push({ engine, check: "one long-lived process", ok: starts === 1, detail: `${starts} start(s)`, ms: 0 });
  console.log(JSON.stringify(results.at(-1)));
  const errs = act.filter((e: any) => e.kind === "error").map((e: any) => e.text);
  if (errs.length) console.log(engine, "errors:", errs.slice(-3));
  if (results.some((r) => r.engine === engine && !r.ok))
    for (const e of act.filter((e: any) => e.kind !== "thought").slice(-40)) console.log("  activity", e.kind, String(e.text).slice(0, 300).replace(/\n/g, " "));
}

console.log("\nSUMMARY");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.engine.padEnd(9)} ${r.check.padEnd(40)} ${(r.ms / 1000).toFixed(1)}s  ${r.detail}`);
await h.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
