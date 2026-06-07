import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { goals, tasks, agents, workspaces } from "../db/schema.js";
import { loadOrgNodes } from "../routes/org.js";
import { chatJson, plannerEnabled } from "./completion.js";
import { createTask, addLink, startBacklogTask, logActivity } from "./tasks-core.js";
import { writePlan, loadLedger } from "./ledger-core.js";
import { listAgentSkills, type AgentSkill } from "./agent-skills-fs.js";
import { embed, cosine, embeddingsEnabled } from "./embeddings.js";

// ─────────────────────────────────────────────────────────────────────────
// The goal planner — CircleChat's "auto-delegating manager".
//
// Given a goal, it asks the model (server-side, via the OpenAI-compatible
// gateway) for a PraisonAI-AutoAgents-style decomposition: a list of tasks,
// each routed to a teammate, with explicit dependencies. It then MATERIALISES
// that plan as real board objects — tasks carrying the goalId, `blocks` edges
// for every dependency, assignees resolved against the org roster — and starts
// the root tasks. From there the existing advanceWorkflow engine runs the
// pipeline: as each task is marked done, its dependents auto-start and their
// agents wake. Completion rolls back up to the goal.
//
// This is the piece that turns "the org chart is modeled, not executed" into a
// goal that decomposes itself into a delegation tree.
// ─────────────────────────────────────────────────────────────────────────

// One planned dependency: a prerequisite task key, optionally gated by a label
// the prerequisite must carry when it completes (a decision branch).
const DepSchema = z.union([
  z.string(),
  z.object({ key: z.string(), condition: z.string().max(60).optional() }),
]);

const PlannedTaskSchema = z.object({
  key: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional().default(""),
  assignee: z.string().max(80).optional().default(""),
  dependsOn: z.array(DepSchema).optional().default([]),
  labels: z.array(z.string().max(40)).optional().default([]),
  // WHY this task / why this owner (the WHY in WHERE-WHAT-WHY delegation cues).
  // Recorded as task activity for explainable routing.
  rationale: z.string().max(500).optional().default(""),
});

const PlanSchema = z.object({
  tasks: z.array(PlannedTaskSchema).min(1).max(15),
});

type PlannedTask = z.infer<typeof PlannedTaskSchema>;

interface RosterEntry {
  memberId: string;
  kind: "user" | "agent";
  name: string;
  handle: string;
  title: string;
  brief: string;
  skills: AgentSkill[];
  capabilities: string[];
  // Concatenated capability surface (title + brief + skills + capability tags)
  // used for both the planner prompt and embedding/keyword routing.
  profileText: string;
}

export interface PlanResult {
  goalId: string;
  taskCount: number;
  rootCount: number;
  tasks: Array<{ id: string; title: string; assigneeHandle: string | null; dependsOn: string[]; reason: string }>;
}

export type PlanError =
  | "goal_not_found"
  | "wrong_workspace"
  | "planner_unconfigured"
  | "already_planned"
  | "no_roster"
  | "plan_generation_failed"
  | "empty_plan"
  | "cyclic_plan";

// Build a teammate's capability profile from the strongest signals available:
// the skills they've actually installed (name + description — the Agent-Skills
// "progressive disclosure" discovery signal), their role (title), their brief,
// and any manual capability tags (an optional supplement, not the source of
// truth). This single text blob drives both the planner prompt and routing.
function buildProfileText(parts: {
  title: string;
  brief: string;
  skills: AgentSkill[];
  capabilities: string[];
}): string {
  const skillText = parts.skills
    .map((s) => (s.summary ? `${s.name}: ${s.summary}` : s.name))
    .join("; ");
  return [
    parts.title,
    parts.brief,
    skillText ? `skills — ${skillText}` : "",
    parts.capabilities.length ? `also — ${parts.capabilities.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

// Build the workspace roster the planner routes against: every agent (with its
// installed skills, role, and brief) plus human members, so both the model and
// the embedding matcher can route a subtask to the best-fit teammate.
async function loadRoster(workspaceId: string): Promise<RosterEntry[]> {
  const nodes = await loadOrgNodes(workspaceId);
  const agentRows = await db
    .select({ id: agents.id, handle: agents.handle, kind: agents.kind, brief: agents.brief, capabilities: agents.capabilities })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  const agentByHandle = new Map(agentRows.map((a) => [a.handle, a]));

  const roster: RosterEntry[] = [];
  for (const n of nodes) {
    const agentRow = n.kind === "agent" ? agentByHandle.get(n.handle) : undefined;
    const brief = agentRow?.brief ?? "";
    const capabilities = agentRow?.capabilities ?? [];
    // Read installed skills from disk (best-effort — empty if unreachable, e.g.
    // a webhook agent with no local home; routing then leans on title/brief).
    const skills = agentRow
      ? await listAgentSkills({ id: agentRow.id, handle: agentRow.handle, kind: agentRow.kind }).catch(() => [])
      : [];
    const title = n.title ?? "";
    roster.push({
      memberId: n.memberId,
      kind: n.kind,
      name: n.name,
      handle: n.handle,
      title,
      brief,
      skills,
      capabilities,
      profileText: buildProfileText({ title, brief, skills, capabilities }),
    });
  }
  return roster;
}

// Resolve a planned task to the best-fit teammate, with an explainable reason.
// Order of signals (strongest first):
//   1. Exact @handle the planner named — it saw each teammate's skills + role.
//   2. Semantic match: cosine of the task vector against each teammate's
//      capability-profile vector (skills + role + brief). The literature's
//      recommended routing signal; needs an embeddings backend.
//   3. Keyword overlap of the task text against the profile text (no-embeddings
//      fallback).
//   4. Unassigned — the goal owner picks it up.
// Humans are eligible, but agents get a small tie-break bias so work routes to
// automation by default.
function resolveAssignee(
  planned: PlannedTask,
  roster: RosterEntry[],
  vecs?: { taskVec: number[] | null; agentVecs: Map<string, number[]> },
): { entry: RosterEntry | null; reason: string } {
  const wanted = (planned.assignee || "").trim().toLowerCase().replace(/^@/, "");
  if (wanted) {
    const exact = roster.find((r) => r.handle.toLowerCase() === wanted);
    if (exact) return { entry: exact, reason: `named by planner (@${exact.handle})` };
  }

  // 2. Semantic match against capability-profile vectors.
  if (vecs?.taskVec && vecs.agentVecs.size) {
    let best: RosterEntry | null = null;
    let bestScore = -1;
    for (const r of roster) {
      const v = vecs.agentVecs.get(r.memberId);
      if (!v) continue;
      let score = cosine(vecs.taskVec, v);
      if (r.kind === "agent") score += 0.03; // tie-break toward automation
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (best && bestScore >= 0.18) {
      return { entry: best, reason: `best skills/role match (semantic ${bestScore.toFixed(2)})` };
    }
  }

  // 3. Keyword overlap over the profile text.
  const needleSet = new Set(
    `${wanted} ${planned.title} ${planned.description}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
  let best: RosterEntry | null = null;
  let bestScore = 0;
  for (const r of roster) {
    const tokens = r.profileText
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    let score = tokens.reduce((acc, t) => acc + (needleSet.has(t) ? 1 : 0), 0);
    if (r.kind === "agent") score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (bestScore >= 1) return { entry: best, reason: "keyword match on skills/role" };
  return { entry: null, reason: "left unassigned (no clear match)" };
}

function buildMessages(
  goalTitle: string,
  goalBody: string,
  mission: string,
  roster: RosterEntry[],
  replanNote?: string,
) {
  const rosterLines = roster
    .map((r) => {
      const title = r.title ? ` (${r.title})` : "";
      const skillNames = r.skills.map((s) => s.name).filter((n) => n !== "circlechat");
      const skills = skillNames.length ? ` — skills: ${skillNames.join(", ")}` : "";
      const caps = r.capabilities.length ? ` — also: ${r.capabilities.join(", ")}` : "";
      return `- @${r.handle} [${r.kind}]${title}${skills}${caps}`;
    })
    .join("\n");

  const system = [
    "You are the planning manager for a team of AI agents and humans working in a shared workspace.",
    "Decompose the GOAL into the SMALLEST set of concrete, independently-assignable tasks that together achieve it — typically 3 to 8, never more than 15.",
    "Each task must be a real unit of work with a clear deliverable. Assign it to the single best-fit teammate from the ROSTER by matching the task to their skills and role — use their exact @handle.",
    "Express ordering with dependencies: a task lists the keys of tasks that must finish before it can start. Parallelise anything that can run at once — do not chain tasks that don't depend on each other.",
    "Use a dependency object {\"key\":\"t2\",\"condition\":\"approved\"} only for a true decision branch, where t2 must complete carrying the label \"approved\" for this task to run.",
    "For each task give a one-line `rationale`: WHY this task is needed and WHY this teammate (their skill/role fit).",
    "Return ONLY a JSON object of this exact shape, no prose, no markdown fence:",
    '{"tasks":[{"key":"t1","title":"...","description":"what done looks like","assignee":"handle","dependsOn":[],"labels":[],"rationale":"why this task + why this owner"}]}',
  ].join("\n");

  const user = [
    mission ? `WORKSPACE MISSION: ${mission}` : "",
    `GOAL: ${goalTitle}`,
    goalBody ? `GOAL DETAIL: ${goalBody}` : "",
    replanNote || "",
    "",
    "ROSTER (assign each task to one @handle):",
    rosterLines || "(no teammates available — leave assignee empty)",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// Detect a cycle in the planned dependency graph (keys → deps). A cyclic plan
// can never start (every task waits on another) so we reject it outright.
function hasCycle(planned: PlannedTask[]): boolean {
  const deps = new Map<string, string[]>();
  for (const t of planned) {
    deps.set(
      t.key,
      (t.dependsOn ?? []).map((d) => (typeof d === "string" ? d : d.key)),
    );
  }
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=in-stack 2=done
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) {
      if (deps.has(d) && visit(d)) return true;
    }
    state.set(k, 2);
    return false;
  };
  for (const k of deps.keys()) if (visit(k)) return true;
  return false;
}

export async function planGoal(params: {
  goalId: string;
  workspaceId: string;
  actorMemberId: string;
  // Re-plan: the goal already has tasks but stalled. Bypass the idempotency
  // guard and feed the ledger's known dead-ends/facts into the prompt so the
  // planner produces a DIFFERENT plan instead of re-proposing what failed.
  isReplan?: boolean;
}): Promise<{ plan: PlanResult } | { error: PlanError }> {
  const { goalId, workspaceId, actorMemberId, isReplan = false } = params;

  const [goal] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
  if (!goal) return { error: "goal_not_found" };
  if (goal.workspaceId !== workspaceId) return { error: "wrong_workspace" };
  if (!plannerEnabled()) return { error: "planner_unconfigured" };

  // Idempotency: don't re-plan a goal that already has live tasks — UNLESS this
  // is an explicit re-plan triggered by the stall detector.
  if (!isReplan) {
    const existing = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.goalId, goalId), eq(tasks.archived, false)))
      .limit(1);
    if (existing.length) return { error: "already_planned" };
  }

  const roster = await loadRoster(workspaceId);
  if (!roster.length) return { error: "no_roster" };

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);

  // On re-plan, build a corrective note from the ledger so the planner avoids
  // known dead-ends and builds on established facts.
  let replanNote = "";
  if (isReplan) {
    const led = await loadLedger(goalId).catch(() => null);
    const parts: string[] = [
      "NOTE: this goal STALLED under the previous plan — produce a DIFFERENT decomposition that gets it moving.",
    ];
    if (led?.facts.length) parts.push(`ESTABLISHED FACTS (build on these): ${led.facts.join("; ")}`);
    if (led?.triedDeadEnds.length)
      parts.push(`DEAD-ENDS (do NOT propose these again): ${led.triedDeadEnds.join("; ")}`);
    replanNote = parts.join("\n");
  }

  await db.update(goals).set({ status: "planning", updatedAt: new Date() }).where(eq(goals.id, goalId));

  const raw = await chatJson<unknown>(
    buildMessages(goal.title, goal.bodyMd, ws?.mission ?? "", roster, replanNote),
    { temperature: 0.2, maxTokens: 4000, timeoutMs: 150_000 },
  );
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    // Observability: this used to fail silently, leaving only the bare
    // "plan_generation_failed" code on the goal row — undiagnosable. Log
    // whether the LLM returned nothing vs returned JSON the schema rejected.
    console.error(
      `[planner] plan_generation_failed for ${goalId}: ` +
        (raw === null
          ? "chatJson returned null (LLM unreachable/timeout or no JSON in reply)"
          : `schema rejected: ${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")} — raw: ${JSON.stringify(raw).slice(0, 300)}`),
    );
    await db.update(goals).set({ status: "open", updatedAt: new Date() }).where(eq(goals.id, goalId));
    return { error: "plan_generation_failed" };
  }
  const planned = parsed.data.tasks;
  if (!planned.length) {
    await db.update(goals).set({ status: "open", updatedAt: new Date() }).where(eq(goals.id, goalId));
    return { error: "empty_plan" };
  }
  if (hasCycle(planned)) {
    await db.update(goals).set({ status: "open", updatedAt: new Date() }).where(eq(goals.id, goalId));
    return { error: "cyclic_plan" };
  }

  // Re-plan only: retire the stalled OPEN tasks (keep done ones — that work is
  // real) so the new decomposition replaces them instead of duplicating. Done
  // here, only once we have a valid new plan in hand, so a failed re-plan
  // doesn't wipe the board.
  if (isReplan) {
    await db
      .update(tasks)
      .set({ archived: true, updatedAt: new Date() })
      .where(and(eq(tasks.goalId, goalId), eq(tasks.archived, false), ne(tasks.status, "done")));
  }

  // Precompute embedding vectors for semantic routing: each teammate's
  // capability profile and each task's text, in two batch calls. Null when no
  // embeddings backend is configured — resolveAssignee then falls back to the
  // planner's @handle pick and keyword overlap.
  const agentVecs = new Map<string, number[]>();
  let taskVecs: (number[] | null)[] = planned.map(() => null);
  if (embeddingsEnabled()) {
    const profileVecs = await embed(roster.map((r) => r.profileText || r.handle)).catch(() => null);
    if (profileVecs) roster.forEach((r, i) => profileVecs[i] && agentVecs.set(r.memberId, profileVecs[i]));
    const tv = await embed(planned.map((p) => `${p.title}\n${p.description ?? ""}`)).catch(() => null);
    if (tv) taskVecs = tv;
  }

  // Materialise. Pass 1: create every task as backlog (trigger deferred so a
  // still-blocked task doesn't wake its agent). Map planned key → real task id,
  // and log the routing rationale (WHERE-WHAT-WHY) as task activity.
  const keyToTaskId = new Map<string, string>();
  const created: Array<{ id: string; title: string; assigneeHandle: string | null; dependsOn: string[]; reason: string }> = [];
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    const { entry: assignee, reason } = resolveAssignee(p, roster, {
      taskVec: taskVecs[i],
      agentVecs,
    });
    const r = await createTask(
      {
        title: p.title,
        bodyMd: p.description ?? "",
        status: "backlog",
        goalId,
        assignees: assignee ? [assignee.memberId] : [],
        labels: p.labels ?? [],
        deferAssigneeTrigger: true,
      },
      actorMemberId,
      workspaceId,
    );
    if ("error" in r) continue; // skip a task that failed to create; plan still stands
    keyToTaskId.set(p.key, r.task.id);
    // WHERE (assignee) + WHY (rationale + routing reason), recorded for an
    // explainable, auditable delegation trail.
    await logActivity(r.task.id, actorMemberId, "planned", {
      goalId,
      assignee: assignee?.handle ?? null,
      routing: reason,
      rationale: p.rationale || null,
    }).catch(() => {});
    created.push({
      id: r.task.id,
      title: p.title,
      assigneeHandle: assignee?.handle ?? null,
      dependsOn: (p.dependsOn ?? []).map((d) => (typeof d === "string" ? d : d.key)),
      reason,
    });
  }

  // Pass 2: wire dependency edges. `source blocks target` — the prerequisite
  // (dep) blocks the task that depends on it.
  const hasIncoming = new Set<string>();
  for (const p of planned) {
    const targetId = keyToTaskId.get(p.key);
    if (!targetId) continue;
    for (const dep of p.dependsOn ?? []) {
      const depKey = typeof dep === "string" ? dep : dep.key;
      const condition = typeof dep === "string" ? null : dep.condition ?? null;
      const sourceId = keyToTaskId.get(depKey);
      if (!sourceId || sourceId === targetId) continue;
      await addLink(sourceId, targetId, "blocks", actorMemberId, workspaceId, condition);
      hasIncoming.add(targetId);
    }
  }

  // Pass 3: start the roots (no unconditional prerequisite). Conditional-only
  // targets are also roots in the sense that nothing hard-blocks them, but to
  // keep branches honest we only auto-start tasks with zero incoming edges.
  let rootCount = 0;
  for (const c of created) {
    if (hasIncoming.has(c.id)) continue;
    await startBacklogTask(
      c.id,
      actorMemberId,
      workspaceId,
      { from: "backlog", to: "in_progress", planned: true, goalId },
      "A new goal task is ready for you",
    );
    rootCount++;
  }

  await db.update(goals).set({ status: "in_progress", updatedAt: new Date() }).where(eq(goals.id, goalId));

  // Externalize the plan into the goal ledger so every agent wake reads it
  // (via the context packet) instead of reconstructing intent from chat. On a
  // re-plan this preserves accumulated facts/dead-ends and bumps the version.
  const planText = created
    .map(
      (c) =>
        `- ${c.title}${c.assigneeHandle ? ` → @${c.assigneeHandle}` : " (unassigned)"}` +
        `${c.dependsOn.length ? ` [after: ${c.dependsOn.join(", ")}]` : ""}` +
        `${c.reason ? ` — ${c.reason}` : ""}`,
    )
    .join("\n");
  await writePlan({ goalId, workspaceId, plan: planText, isReplan }).catch(() => {});

  return {
    plan: { goalId, taskCount: created.length, rootCount, tasks: created },
  };
}
