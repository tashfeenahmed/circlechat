// End-to-end test of AUTOMATIC planning: creating a goal in an 'auto' workspace
// decomposes + starts it with no manual plan call, driven by the background
// goal-plan worker. Also exercises the sweeper picking up an unplanned goal.
//   createdb cc_autoplan && node scripts/autoplan-e2e.mjs ; dropdb cc_autoplan
import http from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const DB = "postgres://postgres:circlechat@localhost:5432/cc_autoplan";
process.env.DATABASE_URL = DB;
process.env.HERMES_HOMES_DIR = "/tmp/cc-autoplan-homes";
process.env.GOAL_PLAN_DEBOUNCE_MS = "0"; // plan immediately in the test

// Mock LLM → fixed 3-task plan.
const PLAN = {
  tasks: [
    { key: "a", title: "Research the market", assignee: "remy", dependsOn: [], rationale: "remy researches" },
    { key: "b", title: "Design the page", assignee: "dara", dependsOn: ["a"], rationale: "dara designs" },
    { key: "c", title: "Build the page", assignee: "dara", dependsOn: ["b"], rationale: "dara builds" },
  ],
};
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(PLAN) } }] })); });
});
await new Promise((r) => mock.listen(0, r));
process.env.PLANNER_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
process.env.PLANNER_MODEL = "mock";

const postgres = (await import("postgres")).default;
const { drizzle } = await import("drizzle-orm/postgres-js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
{ const m = postgres(DB, { max: 1 }); await migrate(drizzle(m), { migrationsFolder: "./migrations" }); await m.end(); }

const { db } = await import("../dist/db/index.js");
const schema = await import("../dist/db/schema.js");
const { eq } = await import("drizzle-orm");
const wsId = "ws_ap01";
await db.insert(schema.workspaces).values({ id: wsId, name: "AP", handle: "ap", createdBy: "u_o", mission: "Ship things" }); // auto_plan defaults to 'auto'
await db.insert(schema.users).values({ id: "u_o", email: "o@x.com", name: "O", handle: "owner", passwordHash: "x" });
await db.insert(schema.members).values({ id: "m_o", workspaceId: wsId, kind: "user", refId: "u_o" });
async function agent(id, handle, title, skills) {
  await db.insert(schema.agents).values({ id, workspaceId: wsId, handle, name: handle, kind: "openclaw", adapter: "webhook", title, capabilities: [], botToken: `cc_${id}`, createdBy: "m_o" });
  await db.insert(schema.members).values({ id: `m_${handle}`, workspaceId: wsId, kind: "agent", refId: id, reportsTo: "m_o" });
  const root = join(process.env.HERMES_HOMES_DIR, `.openclaw-${handle}`, "skills");
  for (const [n, d] of Object.entries(skills)) { await fs.mkdir(join(root, n), { recursive: true }); await fs.writeFile(join(root, n, "DESCRIPTION.md"), `---\nname: ${n}\ndescription: ${d}\n---\n`); }
}
await fs.rm(process.env.HERMES_HOMES_DIR, { recursive: true, force: true });
await agent("a_remy", "remy", "Researcher", { research: "Market research." });
await agent("a_dara", "dara", "Designer", { design: "Design and build pages." });

const { startGoalPlanWorker } = await import("../dist/agents/goal-planner-worker.js");
const { goalQueue } = await import("../dist/lib/goal-queue.js");
const { createGoal } = await import("../dist/lib/goals-core.js");
const worker = startGoalPlanWorker();

let ok = true;
const assert = (c, m) => { if (!c) { ok = false; console.error("✗ " + m); } else console.log("✓ " + m); };
const tasksFor = async (gid) => db.select().from(schema.tasks).where(eq(schema.tasks.goalId, gid));
async function waitForTasks(gid, label, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const r = await tasksFor(gid); if (r.length) return r; await new Promise((r) => setTimeout(r, 400)); }
  return [];
}

// 1. Plan-on-create: createGoal enqueues; the worker plans it automatically.
console.log("=== plan-on-create ===");
const g1 = await createGoal({ title: "Launch the landing page" }, "m_o", wsId);
const t1 = await waitForTasks(g1.goal.id, "create");
assert(t1.length === 3, `goal auto-planned on create → ${t1.length} tasks (no manual plan call)`);
const [g1row] = await db.select().from(schema.goals).where(eq(schema.goals.id, g1.goal.id));
assert(g1row.status === "in_progress", "goal moved to in_progress automatically");
assert(t1.some((t) => t.status === "in_progress"), "a root task auto-started");

// 2. Sweeper: insert a raw open goal (no enqueue), fire a sweep, it gets planned.
console.log("=== sweeper backstop ===");
const g2id = "goal_sweeptest01";
await db.insert(schema.goals).values({ id: g2id, workspaceId: wsId, title: "Second goal", status: "open", ownerMemberId: "m_o", createdBy: "m_o" });
await goalQueue.add("sweep", { kind: "sweep" });
const t2 = await waitForTasks(g2id, "sweep");
assert(t2.length === 3, `sweeper picked up the unplanned goal → ${t2.length} tasks`);

await worker.close();
await goalQueue.close();
mock.close();
console.log(ok ? "\nALL PASS ✅" : "\nFAILURES ❌");
process.exit(ok ? 0 : 1);
