import { and, eq, inArray, desc, asc, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import { goals, tasks, members, workspaces } from "../db/schema.js";
import { id } from "./ids.js";
import { publishToWorkspace } from "./events.js";
import { hydrateTasks } from "./tasks-core.js";
import { enqueueGoalPlan } from "./goal-queue.js";

export const GOAL_STATUSES = ["open", "planning", "in_progress", "done", "archived"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// A 'project' is a top-level container; a 'goal' is a unit of intent the
// planner decomposes into tasks. The mission → project → goal tier.
export const GOAL_KINDS = ["goal", "project"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

type GoalRow = typeof goals.$inferSelect;

export async function loadGoal(goalId: string): Promise<GoalRow | null> {
  const [g] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
  return g ?? null;
}

// Walk parent_goal_id from a goal up to its root, returning the chain
// top-first: [rootProject, …, directGoal]. Gives agents the full "why"
// ancestry of a task, not just its immediate goal. Bounded so a corrupt
// cycle can't loop forever.
export async function getGoalAncestry(goalId: string): Promise<GoalRow[]> {
  const chain: GoalRow[] = [];
  const seen = new Set<string>();
  let cur: string | null = goalId;
  while (cur && !seen.has(cur) && chain.length < 16) {
    seen.add(cur);
    const g = await loadGoal(cur);
    if (!g) break;
    chain.push(g);
    cur = g.parentGoalId;
  }
  return chain.reverse();
}

function guard(
  g: GoalRow | null,
  workspaceId: string,
): { ok: boolean; error?: "not_found" | "wrong_workspace" } {
  if (!g) return { ok: false, error: "not_found" };
  if (g.workspaceId !== workspaceId) return { ok: false, error: "wrong_workspace" };
  return { ok: true };
}

// Attach a {total, done, inProgress} task tally to each goal so the UI/agents
// can show progress without a second round-trip.
async function withCounts(rows: GoalRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({
      goalId: tasks.goalId,
      status: tasks.status,
      c: dsql<number>`count(*)::int`.as("c"),
    })
    .from(tasks)
    .where(and(inArray(tasks.goalId, ids), eq(tasks.archived, false)))
    .groupBy(tasks.goalId, tasks.status);
  const tally = new Map<string, { total: number; done: number; inProgress: number }>();
  for (const row of counts) {
    if (!row.goalId) continue;
    const t = tally.get(row.goalId) ?? { total: 0, done: 0, inProgress: 0 };
    const n = Number(row.c) || 0;
    t.total += n;
    if (row.status === "done") t.done += n;
    if (row.status === "in_progress") t.inProgress += n;
    tally.set(row.goalId, t);
  }
  return rows.map((r) => ({
    ...r,
    taskCounts: tally.get(r.id) ?? { total: 0, done: 0, inProgress: 0 },
  }));
}

export interface CreateGoalInput {
  title: string;
  bodyMd?: string;
  parentGoalId?: string | null;
  ownerMemberId?: string | null;
  status?: GoalStatus;
  kind?: GoalKind;
}

export async function createGoal(
  input: CreateGoalInput,
  creatorMemberId: string,
  workspaceId: string,
) {
  if (input.parentGoalId) {
    const parent = await loadGoal(input.parentGoalId);
    if (!parent || parent.workspaceId !== workspaceId) return { error: "invalid_parent" as const };
  }
  // Default the owner to the creator so completion roll-up always has a target.
  let owner = input.ownerMemberId ?? creatorMemberId;
  if (owner) {
    const [m] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, owner), eq(members.workspaceId, workspaceId)))
      .limit(1);
    if (!m) owner = creatorMemberId;
  }
  const goalId = id("goal");
  await db.insert(goals).values({
    id: goalId,
    workspaceId,
    parentGoalId: input.parentGoalId ?? null,
    kind: input.kind ?? "goal",
    title: input.title,
    bodyMd: input.bodyMd ?? "",
    status: input.status ?? "open",
    ownerMemberId: owner,
    createdBy: creatorMemberId,
  });
  const [row] = await db.select().from(goals).where(eq(goals.id, goalId));
  const [hydrated] = await withCounts([row]);
  await publishToWorkspace(workspaceId, { type: "goal.new", workspaceId, goal: hydrated });

  // Auto-planning: in an 'auto' workspace, a brand-new open goal decomposes
  // itself (debounced, off the request path). No manual Plan click. The
  // sweeper backstops anything missed. Fire-and-forget — never blocks create.
  if ((row.status ?? "open") === "open") {
    const [ws] = await db.select({ autoPlan: workspaces.autoPlan }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (ws?.autoPlan === "auto") {
      enqueueGoalPlan(goalId, workspaceId).catch(() => {});
    }
  }
  return { goal: hydrated };
}

// The workspace's auto-planning policy ('auto' | 'off'), so the UI knows
// whether to show a manual Plan button.
export async function workspaceAutoPlan(workspaceId: string): Promise<string> {
  const [ws] = await db.select({ autoPlan: workspaces.autoPlan }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return ws?.autoPlan ?? "auto";
}

export async function listGoals(workspaceId: string) {
  const rows = await db
    .select()
    .from(goals)
    .where(eq(goals.workspaceId, workspaceId))
    .orderBy(desc(goals.createdAt));
  return { goals: await withCounts(rows), autoPlan: await workspaceAutoPlan(workspaceId) };
}

export async function getGoalDetail(goalId: string, workspaceId: string) {
  const g = await loadGoal(goalId);
  const gr = guard(g, workspaceId);
  if (!gr.ok) return { error: gr.error! };
  const [hydrated] = await withCounts([g!]);
  const taskRows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.goalId, goalId), eq(tasks.archived, false)))
    .orderBy(asc(tasks.status), asc(tasks.position), asc(tasks.createdAt));
  const subGoalRows = await db
    .select()
    .from(goals)
    .where(eq(goals.parentGoalId, goalId))
    .orderBy(desc(goals.createdAt));
  return {
    goal: hydrated,
    tasks: await hydrateTasks(taskRows),
    subGoals: await withCounts(subGoalRows),
  };
}

export interface UpdateGoalInput {
  title?: string;
  bodyMd?: string;
  status?: GoalStatus;
  ownerMemberId?: string | null;
  kind?: GoalKind;
}

export async function updateGoal(
  goalId: string,
  input: UpdateGoalInput,
  workspaceId: string,
) {
  const g = await loadGoal(goalId);
  const gr = guard(g, workspaceId);
  if (!gr.ok) return { error: gr.error! };
  const patch: Partial<typeof goals.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.bodyMd !== undefined) patch.bodyMd = input.bodyMd;
  if (input.status !== undefined) patch.status = input.status;
  if (input.ownerMemberId !== undefined) patch.ownerMemberId = input.ownerMemberId;
  if (input.kind !== undefined) patch.kind = input.kind;
  await db.update(goals).set(patch).where(eq(goals.id, goalId));
  const [row] = await db.select().from(goals).where(eq(goals.id, goalId));
  const [hydrated] = await withCounts([row]);
  await publishToWorkspace(workspaceId, { type: "goal.updated", workspaceId, goalId, goal: hydrated });
  return { goal: hydrated };
}

export async function deleteGoal(goalId: string, workspaceId: string) {
  const g = await loadGoal(goalId);
  const gr = guard(g, workspaceId);
  if (!gr.ok) return { error: gr.error! };
  // Detach tasks rather than delete them — the work is still real even if the
  // goal that framed it goes away.
  await db.update(tasks).set({ goalId: null }).where(eq(tasks.goalId, goalId));
  await db.update(goals).set({ parentGoalId: null }).where(eq(goals.parentGoalId, goalId));
  await db.delete(goals).where(eq(goals.id, goalId));
  await publishToWorkspace(workspaceId, { type: "goal.deleted", workspaceId, goalId });
  return { ok: true as const };
}
