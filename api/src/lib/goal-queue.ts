import { Queue } from "bullmq";
import { redis } from "./redis.js";

// Queue that drives automatic goal planning. Three job shapes:
//   { kind: "plan", goalId, workspaceId } — decompose one goal (debounced on create)
//   { kind: "sweep" }                      — periodic reconcile of all goals
//   { kind: "mission" }                    — daily mission → new-goal proposals
export const GOAL_QUEUE = "goal-plans";

export interface GoalPlanJob {
  kind: "plan" | "sweep" | "mission";
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

const MISSION_KEY = "mission-sweep";
const MISSION_EVERY_MS = Number(process.env.MISSION_SWEEP_EVERY_MS ?? 86_400_000); // daily

// Install the repeatable mission planner (daily by default). Called once at
// worker boot. Unlike the 3-min sweeper, a 24h repeat must NOT be removed and
// re-added on every boot — that resets the countdown, and frequent deploys
// would postpone the daily run forever. Keep an existing repeat that already
// matches the interval; replace only when the interval changed. (BullMQ fires
// the first repeat one full interval after install — set
// MISSION_SWEEP_EVERY_MS low to exercise it sooner.)
export async function scheduleMissionSweep(): Promise<void> {
  let keep = false;
  for (const r of await goalQueue.getRepeatableJobs()) {
    if (r.name !== MISSION_KEY) continue;
    if (Number(r.every) === MISSION_EVERY_MS) keep = true;
    else await goalQueue.removeRepeatableByKey(r.key);
  }
  if (keep) return;
  await goalQueue.add(
    MISSION_KEY,
    { kind: "mission" },
    { repeat: { every: MISSION_EVERY_MS }, jobId: MISSION_KEY },
  );
}
