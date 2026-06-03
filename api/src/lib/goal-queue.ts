import { Queue } from "bullmq";
import { redis } from "./redis.js";

// Queue that drives automatic goal planning. Two job shapes:
//   { kind: "plan", goalId, workspaceId } — decompose one goal (debounced on create)
//   { kind: "sweep" }                      — periodic reconcile of all goals
export const GOAL_QUEUE = "goal-plans";

export interface GoalPlanJob {
  kind: "plan" | "sweep";
  goalId?: string;
  workspaceId?: string;
}

export const goalQueue = new Queue<GoalPlanJob>(GOAL_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    // The sweeper is the retry mechanism (it re-enqueues open goals), so a
    // single plan job doesn't need BullMQ-level retries.
    attempts: 1,
    removeOnComplete: 200,
    removeOnFail: 200,
  },
});

// Debounce window before a freshly-created goal is planned, so a human editing
// in the UI (or an agent that creates-then-fills) settles first.
const PLAN_DEBOUNCE_MS = Number(process.env.GOAL_PLAN_DEBOUNCE_MS ?? 20_000);

// Enqueue (or re-enqueue) a plan for one goal. jobId = goalId dedupes: a goal
// already waiting to be planned won't pile up duplicate jobs.
export async function enqueueGoalPlan(goalId: string, workspaceId: string, immediate = false): Promise<void> {
  await goalQueue.add(
    "plan",
    { kind: "plan", goalId, workspaceId },
    // BullMQ custom job ids must not contain ':'. jobId = one pending plan/goal.
    { jobId: `plan_${goalId}`, delay: immediate ? 0 : PLAN_DEBOUNCE_MS },
  );
}

const SWEEP_KEY = "goal-sweep";
const SWEEP_EVERY_MS = Number(process.env.GOAL_SWEEP_EVERY_MS ?? 180_000); // 3 min

// Install the repeatable sweeper job. Called once at worker boot.
export async function scheduleGoalSweep(): Promise<void> {
  // Clear any stale repeatable first so the interval can't double up.
  for (const r of await goalQueue.getRepeatableJobs()) {
    if (r.name === SWEEP_KEY) await goalQueue.removeRepeatableByKey(r.key);
  }
  await goalQueue.add(
    SWEEP_KEY,
    { kind: "sweep" },
    { repeat: { every: SWEEP_EVERY_MS }, jobId: SWEEP_KEY },
  );
}
