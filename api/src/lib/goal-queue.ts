import { Queue } from "bullmq";
import { redis } from "./redis.js";
import { envNum } from "./env.js";
import { clearFinishedJob } from "./queue-dedupe.js";

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
    // The sweeper is the retry driver (it re-enqueues open goals every 3 min),
    // so a single plan job doesn't need BullMQ-level retries. That only works
    // because a finished plan job is deleted immediately — see enqueueGoalPlan;
    // while finished plan jobs lingered here, every sweeper re-enqueue was
    // silently discarded as a duplicate id.
    attempts: 1,
    // History kept for the repeatable sweep/mission jobs, which use BullMQ's
    // own per-iteration ids and so can never block a later run.
    removeOnComplete: 200,
    removeOnFail: 200,
  },
});

// Debounce window before a freshly-created goal is planned, so a human editing
// in the UI (or an agent that creates-then-fills) settles first.
const PLAN_DEBOUNCE_MS = envNum("GOAL_PLAN_DEBOUNCE_MS", 20_000, { min: 0 });

// Enqueue (or re-enqueue) a plan for one goal. jobId = goalId dedupes: a goal
// already waiting to be planned won't pile up duplicate jobs.
//
// The dedupe must cover IN-FLIGHT jobs only. BullMQ's fixed-jobId check is
// plain key existence, and a finished job keeps its key while it sits in the
// completed/failed set — so a plan that ran and returned early (deferred, or
// the LLM gateway unreachable: both COMPLETE, they don't fail) used to make
// every later add() for that goal a silent no-op, and the sweeper re-enqueued
// into a black hole for as long as the completed set held the job. Two live
// goals went 70 minutes unplanned that way.
//
// Two guards, deliberately both:
//   • removeOnComplete/removeOnFail true — a plan job's key is gone the moment
//     it finishes, so the id is free for the next attempt;
//   • clearFinishedJob before the add — clears jobs already parked in the
//     completed set (from an older build, or added under other options).
export async function enqueueGoalPlan(goalId: string, workspaceId: string, immediate = false): Promise<void> {
  // BullMQ custom job ids must not contain ':'. jobId = one pending plan/goal.
  const jobId = `plan_${goalId}`;
  await clearFinishedJob(goalQueue, jobId);
  await goalQueue.add(
    "plan",
    { kind: "plan", goalId, workspaceId },
    { jobId, delay: immediate ? 0 : PLAN_DEBOUNCE_MS, removeOnComplete: true, removeOnFail: true },
  );
}

const SWEEP_KEY = "goal-sweep";
const SWEEP_EVERY_MS = envNum("GOAL_SWEEP_EVERY_MS", 180_000, { min: 1 }); // 3 min

// Install the repeatable sweeper job. Called once at worker boot.
// (Safe from the fixed-jobId trap above: for a repeatable, BullMQ uses this id
// to name the SCHEDULE and gives each iteration its own `repeat:<id>:<ms>` job
// id, so a completed tick never blocks the next one.)
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
const MISSION_EVERY_MS = envNum("MISSION_SWEEP_EVERY_MS", 86_400_000, { min: 1 }); // daily

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
