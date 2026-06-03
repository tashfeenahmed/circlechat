// End-to-end test of the goal → auto-delegation vertical against a throwaway
// database and a mock chat-completions server. Proves: migrations apply, a goal
// decomposes into tasks + dependency edges routed to agents, root tasks start,
// and completion rolls back up to the goal.
//
//   createdb cc_plantest && node scripts/plan-e2e.mjs ; dropdb cc_plantest
import http from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const DB = "postgres://postgres:circlechat@localhost:5432/cc_plantest";
process.env.DATABASE_URL = DB;
// Point the skills-root resolver at a throwaway dir and seed per-agent skills
// on disk below, so we exercise the real skills-based routing path.
const HOMES = "/tmp/cc-plantest-homes";
process.env.HERMES_HOMES_DIR = HOMES;

// 1. Mock LLM: a 4-task pipeline (research → draft → publish, plus parallel
//    design) routed by explicit @handle, AND a 5th task with NO handle — that
//    one must route purely on the agent's installed skills.
const PLAN = {
  tasks: [
    { key: "research", title: "Research competitors", assignee: "rachel", dependsOn: [], rationale: "rachel researches" },
    { key: "design", title: "Design the hero section", assignee: "phil", dependsOn: [], rationale: "phil designs" },
    { key: "draft", title: "Draft the landing copy", assignee: "rachel", dependsOn: ["research"], rationale: "rachel writes" },
    { key: "publish", title: "Publish the page", assignee: "phil", dependsOn: ["draft", "design"], rationale: "phil ships" },
    // No assignee — routing must pick rachel from her "seo-audit" skill.
    { key: "seo", title: "Run an SEO audit and keyword research", assignee: "", dependsOn: [], rationale: "needs the seo skill" },
  ],
};
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(PLAN) } }] }));
  });
});
await new Promise((r) => mock.listen(0, r));
const port = mock.address().port;
process.env.PLANNER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.PLANNER_MODEL = "mock";

// 2. Migrate the throwaway DB.
const postgres = (await import("postgres")).default;
const { drizzle } = await import("drizzle-orm/postgres-js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
{
  const m = postgres(DB, { max: 1 });
  await migrate(drizzle(m), { migrationsFolder: "./migrations" });
  await m.end();
  console.log("✓ migrations applied");
}

// 3. Seed: workspace, one human owner, two agent teammates with capabilities.
const { db } = await import("../dist/db/index.js");
const schema = await import("../dist/db/schema.js");
const { eq } = await import("drizzle-orm");

const wsId = "ws_test01";
await db.insert(schema.workspaces).values({ id: wsId, name: "Test", handle: "test", createdBy: "u_owner", mission: "Ship a great landing page" });
await db.insert(schema.users).values({ id: "u_owner", email: "o@x.com", name: "Owner", handle: "owner", passwordHash: "x" });
await db.insert(schema.members).values({ id: "m_owner", workspaceId: wsId, kind: "user", refId: "u_owner" });
// A second human who verifies/completes work — distinct from the goal owner, so
// the owner actually receives the completion notification (no self-notify).
await db.insert(schema.users).values({ id: "u_rev", email: "r@x.com", name: "Reviewer", handle: "reviewer", passwordHash: "x" });
await db.insert(schema.members).values({ id: "m_rev", workspaceId: wsId, kind: "user", refId: "u_rev" });
// Seed an OpenClaw agent (predictable skills root: <HOMES>/.openclaw-<handle>/skills)
// and write its skills to disk as DESCRIPTION.md files with frontmatter.
async function agent(id, handle, title, caps, skills) {
  await db.insert(schema.agents).values({ id, workspaceId: wsId, handle, name: handle, kind: "openclaw", adapter: "webhook", title, capabilities: caps, botToken: `cc_${id}`, createdBy: "m_owner" });
  await db.insert(schema.members).values({ id: `m_${handle}`, workspaceId: wsId, kind: "agent", refId: id, reportsTo: "m_owner" });
  const root = join(HOMES, `.openclaw-${handle}`, "skills");
  for (const [name, description] of Object.entries(skills)) {
    const dir = join(root, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "DESCRIPTION.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  }
}
await fs.rm(HOMES, { recursive: true, force: true });
await agent("a_rachel", "rachel", "Researcher/Writer", ["copywriting"], {
  research: "Conducts competitor and market research.",
  "seo-audit": "Runs an SEO audit and keyword research on a website.",
});
await agent("a_phil", "phil", "Designer/Engineer", ["frontend"], {
  design: "Designs UI mockups and visual layouts.",
  publish: "Builds and deploys web pages.",
});
console.log("✓ seeded workspace + 2 agents (with on-disk skills)");

// 4. Create a goal and plan it.
const { createGoal } = await import("../dist/lib/goals-core.js");
const { planGoal } = await import("../dist/lib/planner.js");
const { updateTask } = await import("../dist/lib/tasks-core.js");

const g = await createGoal({ title: "Ship the v2 landing page" }, "m_owner", wsId);
const goalId = g.goal.id;
console.log(`✓ created goal ${goalId} (owner=${g.goal.ownerMemberId})`);

const r = await planGoal({ goalId, workspaceId: wsId, actorMemberId: "m_owner" });
if (r.error) throw new Error("plan failed: " + r.error);
console.log(`✓ planned: ${r.plan.taskCount} tasks, ${r.plan.rootCount} roots started`);
for (const t of r.plan.tasks) console.log(`    - ${t.title}  → @${t.assigneeHandle}  deps=[${t.dependsOn}]  (${t.reason})`);

let ok = true;
const assert = (cond, msg) => { if (!cond) { ok = false; console.error("✗ " + msg); } else console.log("✓ " + msg); };

assert(r.plan.taskCount === 5, "5 tasks created");
assert(r.plan.rootCount === 3, "3 root tasks started (research + design + seo have no deps)");

// Routing: explicit handles honoured…
const byTitle = Object.fromEntries(r.plan.tasks.map((t) => [t.title, t]));
assert(byTitle["Research competitors"].assigneeHandle === "rachel", "research routed to rachel (named)");
assert(byTitle["Design the hero section"].assigneeHandle === "phil", "design routed to phil (named)");
// …and the NO-handle task routes purely on rachel's installed "seo-audit" skill.
const seo = byTitle["Run an SEO audit and keyword research"];
assert(seo.assigneeHandle === "rachel", "unhandled SEO task routed to rachel via her skills");
assert(/skill|keyword/i.test(seo.reason), `routing reason cites skills (got: "${seo.reason}")`);

// Status: roots in_progress, dependents still backlog (blocked).
const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.goalId, goalId));
const statusByTitle = Object.fromEntries(rows.map((t) => [t.title, t.status]));
assert(statusByTitle["Research competitors"] === "in_progress", "research started");
assert(statusByTitle["Design the hero section"] === "in_progress", "design started");
assert(statusByTitle["Draft the landing copy"] === "backlog", "draft still blocked");
assert(statusByTitle["Publish the page"] === "backlog", "publish still blocked");

// Routing rationale is recorded as task activity (WHERE-WHAT-WHY trail).
const seoActivity = await db
  .select()
  .from(schema.taskActivity)
  .where(eq(schema.taskActivity.taskId, seo.id));
assert(
  seoActivity.some((a) => a.kind === "planned" && a.payload?.assignee === "rachel"),
  "planned activity logged with assignee + rationale",
);

// Dependency edges exist.
const links = await db.select().from(schema.taskLinks);
assert(links.filter((l) => l.kind === "blocks").length === 3, "3 blocks edges wired (research→draft, draft→publish, design→publish)");

// Goal moved to in_progress, not done.
const [goalRow] = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId));
assert(goalRow.status === "in_progress", "goal is in_progress after planning");

// 5. Drive the workflow: complete research → draft auto-starts. We bypass the
//    evidence gate by marking done as the human owner (humans are the verifier).
const idByTitle = Object.fromEntries(rows.map((t) => [t.title, t.id]));
async function done(title) {
  const res = await updateTask(idByTitle[title], { status: "done" }, "m_rev", wsId);
  if (res.error) throw new Error(`done(${title}) failed: ${res.error}`);
}
await done("Research competitors");
{
  const [draft] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, idByTitle["Draft the landing copy"]));
  assert(draft.status === "in_progress", "draft auto-started after research done (advanceWorkflow)");
}
await done("Design the hero section");
await done("Draft the landing copy");
{
  const [pub] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, idByTitle["Publish the page"]));
  assert(pub.status === "in_progress", "publish auto-started after BOTH draft+design done (AND-join)");
}
await done("Publish the page");
await done("Run an SEO audit and keyword research"); // the parallel root

// 6. Goal completion roll-up.
const [finalGoal] = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId));
assert(finalGoal.status === "done", "goal rolled up to done after all tasks complete");

// Owner got a "Goal complete" notification.
const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.memberId, "m_owner"));
assert(notes.some((n) => n.title === "Goal complete"), "owner notified of goal completion");

mock.close();
console.log(ok ? "\nALL PASS ✅" : "\nFAILURES ❌");
process.exit(ok ? 0 : 1);
