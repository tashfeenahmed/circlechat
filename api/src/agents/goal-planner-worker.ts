import { Worker } from "bullmq";
import { and, eq, lt, inArray } from "drizzle-orm";
import { redis } from "../lib/redis.js";
import { db } from "../db/index.js";
import { goals, tasks, workspaces } from "../db/schema.js";
import { GOAL_QUEUE, type GoalPlanJob, enqueueGoalPlan } from "../lib/goal-queue.js";
import { planGoal } from "../lib/planner.js";
import { notify } from "../lib/notifications.js";

// Give up after this many failed planning attempts (the sweeper is the retry
// driver, so each attempt is one sweep tick apart — backoff for free).
const MAX_PLAN_ATTEMPTS = Number(process.env.GOAL_MAX_PLAN_ATTEMPTS ?? 3);
// A goal stuck in `planning` longer than this had its worker die mid-plan —
// reset it to `open` so the sweeper re-plans it.
const STUCK_PLANNING_MS = Number(process.env.GOAL_STUCK_PLANNING_MS ?? 300_000); // 5 min
// Cap goals planned per sweep tick — a coarse rate limit until real budgets land.
const SWEEP_BATCH = Number(process.env.GOAL_SWEEP_BATCH ?? 20);

// Errors that mean "stop, don't count an attempt" (nothing to retry).
const TERMINAL_NO_COUNT = new Set(["already_planned", "goal_not_found", "wrong_workspace"]);

async function handlePlan(goalId: string): Promise<void> {
  const [goal] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
  if (!goal) return;
  // Only plan goals that are genuinely open and unplanned, in auto workspaces.
  // (status guard + planGoal's own 0-tasks guard prevent double-planning.)
  if (goal.status !== "open") return;
  if (goal.planAttempts >= MAX_PLAN_ATTEMPTS) return;
  const [ws] = await db.select({ autoPlan: workspaces.autoPlan }).from(workspaces).where(eq(workspaces.id, goal.workspaceId)).limit(1);
  if (ws?.autoPlan !== "auto") return;

  const r = await planGoal({ goalId, workspaceId: goal.workspaceId, actorMemberId: goal.ownerMemberId ?? goal.createdBy });
  if (!("error" in r)) {
    if (goal.lastPlanError) await db.update(goals).set({ lastPlanError: null }).where(eq(goals.id, goalId));
    return;
  }
  if (TERMINAL_NO_COUNT.has(r.error)) return;

  // Count the failed attempt; give up + notify the owner once we hit the cap.
  const attempts = goal.planAttempts + 1;
  await db.update(goals).set({ planAttempts: attempts, lastPlanError: r.error, updatedAt: new Date() }).where(eq(goals.id, goalId));
  if (attempts >= MAX_PLAN_ATTEMPTS && goal.ownerMemberId) {
    await notify({
      workspaceId: goal.workspaceId,
      memberId: goal.ownerMemberId,
      kind: "system",
      title: "Couldn't auto-plan a goal",
      body: `${goal.title} — ${r.error}. Add detail or plan it manually.`,
      link: `/goals`,
    }).catch(() => {});
  }
}

async function handleSweep(): Promise<void> {
  // 1. Un-stick goals whose planning crashed mid-flight.
  await db
    .update(goals)
    .set({ status: "open", updatedAt: new Date() })
    .where(and(eq(goals.status, "planning"), lt(goals.updatedAt, new Date(Date.now() - STUCK_PLANNING_MS))));

  // 2. Find open, under-attempt goals in auto workspaces; enqueue any with no
  //    tasks yet. Bounded per tick as a coarse rate limit.
  const candidates = await db
    .select({ id: goals.id, workspaceId: goals.workspaceId })
    .from(goals)
    .innerJoin(workspaces, eq(workspaces.id, goals.workspaceId))
    .where(and(eq(goals.status, "open"), lt(goals.planAttempts, MAX_PLAN_ATTEMPTS), eq(workspaces.autoPlan, "auto")))
    .limit(SWEEP_BATCH);
  if (!candidates.length) return;

  const ids = candidates.map((c) => c.id);
  const withTasks = new Set(
    (await db.select({ goalId: tasks.goalId }).from(tasks).where(and(inArray(tasks.goalId, ids), eq(tasks.archived, false)))).map(
      (t) => t.goalId,
    ),
  );
  for (const c of candidates) {
    if (withTasks.has(c.id)) continue; // already planned
    await enqueueGoalPlan(c.id, c.workspaceId, true);
  }
}

// Start the goal-planning worker. Called from the worker process boot.
export function startGoalPlanWorker(): Worker<GoalPlanJob> {
  const w = new Worker<GoalPlanJob>(
    GOAL_QUEUE,
    async (job) => {
      if (job.data.kind === "sweep") return handleSweep();
      if (job.data.kind === "plan" && job.data.goalId) return handlePlan(job.data.goalId);
    },
    { connection: redis, concurrency: 3 },
  );
  w.on("error", (e) => console.error("[goal-planner] error", e));
  w.on("failed", (job, err) => console.error("[goal-planner] job failed", job?.id, err?.message));
  console.log("[goal-planner] worker up, concurrency=3");
  return w;
}
