import { and, eq, inArray, desc, asc, ne, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import { goals, tasks, members, workspaces, goalLedgers } from "../db/schema.js";
import { id } from "./ids.js";
import { goalStatusReasonFor, setGoalStatus } from "./goal-status.js";
import { publishToWorkspace } from "./events.js";
import { hydrateTasks } from "./tasks-core.js";
import { enqueueGoalPlan } from "./goal-queue.js";
import { clampLimit, decodeCursor, encodeCursor, keysetCondition, takePage } from "./list-page.js";
import { SPECTATOR_HIDDEN_GOAL_STATUS } from "./agent-view.js";
import { envNum } from "./env.js";

// `parked` is the auto-parking terminal-until-resumed state: a goal whose tasks
// have not moved for GOAL_PARK_AFTER_MS. It is deliberately NOT `in_progress`
// and NOT `open`, which is what takes it out of every planner query (the stall
// pass selects in_progress, the plan sweeper selects open) — so a dead goal
// stops generating stall alerts and stops being planned against. The owner
// resumes it from the Goals page, which puts it back to `in_progress`.
export const GOAL_STATUSES = ["open", "planning", "in_progress", "parked", "done", "archived"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// How long a goal may go without any task movement before it is auto-parked.
// 14 days by default: on live, 9 of 11 in-progress goals were 17–72 days stale
// and between them drove every stall notification in the system.
export const GOAL_PARK_AFTER_MS = envNum("GOAL_PARK_AFTER_MS", 14 * 24 * 60 * 60 * 1000, {
  min: 1,
});

export interface ParkCandidate {
  status: string;
  /** Newest `updatedAt` across the goal's non-archived tasks; null when it has none. */
  lastTaskMovementAt: Date | null;
  /** The goal row's own updatedAt — the fallback clock for a goal with no tasks. */
  updatedAt: Date;
}

/**
 * Pure parking rule. Only `in_progress` goals park (an `open` goal is waiting on
 * the planner, not on the team; `done`/`archived`/`parked` are already at rest),
 * and only when the most recent movement anywhere under the goal is older than
 * the window. A goal with no tasks at all falls back to its own updatedAt, so a
 * goal the planner could never decompose still comes to rest instead of sitting
 * in_progress forever.
 */
export function shouldParkGoal(
  g: ParkCandidate,
  now: number = Date.now(),
  parkAfterMs: number = GOAL_PARK_AFTER_MS,
): boolean {
  if (g.status !== "in_progress") return false;
  const last = (g.lastTaskMovementAt ?? g.updatedAt)?.getTime();
  if (!Number.isFinite(last)) return false;
  return now - last >= parkAfterMs;
}

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

// Newest-first, paginated on (createdAt, id) — see lib/list-page.ts for why
// keyset rather than OFFSET. `id` is the tiebreaker for goals created inside
// the same millisecond (the planner materialises a tree in one go).
export async function listGoals(
  workspaceId: string,
  opts: { limit?: unknown; cursor?: unknown; includeArchived?: boolean } = {},
) {
  const limit = clampLimit(opts.limit);
  const after = decodeCursor(opts.cursor, 2);
  const conds = [eq(goals.workspaceId, workspaceId)];
  // An archived goal is retired work. The Goals page has always dropped it
  // client-side, so nobody ever saw one — but the API shipped every row, and
  // on the public fishbowl that meant 9 of 32 goals in the payload were
  // retired ones an anonymous visitor could read straight out of devtools.
  // Members/agents still get them (an operator can need the history).
  if (opts.includeArchived === false) {
    conds.push(ne(goals.status, SPECTATOR_HIDDEN_GOAL_STATUS));
  }
  if (after) {
    const cond = keysetCondition([goals.createdAt, goals.id], after, "before", [0]);
    if (cond) conds.push(cond as never);
  }
  const rows = await db
    .select()
    .from(goals)
    .where(and(...conds))
    .orderBy(desc(goals.createdAt), desc(goals.id))
    .limit(limit + 1);
  const { page, hasMore } = takePage(rows, limit);
  const last = page[page.length - 1];
  return {
    goals: await withCounts(page),
    autoPlan: await workspaceAutoPlan(workspaceId),
    nextCursor:
      hasMore && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null,
  };
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
  if (input.ownerMemberId !== undefined) patch.ownerMemberId = input.ownerMemberId;
  if (input.kind !== undefined) patch.kind = input.kind;
  await db.update(goals).set(patch).where(eq(goals.id, goalId));

  // The STATUS is never written here — it goes through setGoalStatus, the one
  // writer that also records the audit event and derives actor_type from the
  // member's kind. (publish:false: we publish the hydrated goal ourselves
  // below, so the board still sees exactly one frame.)
  if (input.status !== undefined && input.status !== g!.status) {
    const actorMemberId = input.ownerMemberId ?? g!.ownerMemberId ?? null;
    await setGoalStatus({
      goalId,
      workspaceId,
      to: input.status,
      actorMemberId,
      reason: goalStatusReasonFor(g!.status, input.status),
      publish: false,
    });
  }

  // Resuming a parked goal: give it a clean slate. Without this the ledger still
  // carries the stall/loop counters and the ancient lastProgressAt that parked
  // it, so the very next sweep would flag it stalled and park it again.
  if (g!.status === "parked" && input.status !== undefined && input.status !== "parked") {
    await db
      .update(goalLedgers)
      .set({ stallCount: 0, loopCount: 0, lastProgressAt: new Date(), updatedAt: new Date() })
      .where(eq(goalLedgers.goalId, goalId))
      .catch(() => {});
  }

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
