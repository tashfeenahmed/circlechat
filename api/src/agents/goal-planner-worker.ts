import { Worker } from "bullmq";
import { and, eq, lt, inArray, sql as dsql } from "drizzle-orm";
import { redis } from "../lib/redis.js";
import { db } from "../db/index.js";
import { goals, tasks, workspaces, goalLedgers, members } from "../db/schema.js";
import { GOAL_QUEUE, type GoalPlanJob, enqueueGoalPlan } from "../lib/goal-queue.js";
import { planGoal } from "../lib/planner.js";
import { bumpStall, assessProgress, writeProgressAssessment } from "../lib/ledger-core.js";
import { notify } from "../lib/notifications.js";

// Give up after this many failed planning attempts (the sweeper is the retry
// driver, so each attempt is one sweep tick apart — backoff for free).
const MAX_PLAN_ATTEMPTS = Number(process.env.GOAL_MAX_PLAN_ATTEMPTS ?? 3);
// A goal stuck in `planning` longer than this had its worker die mid-plan —
// reset it to `open` so the sweeper re-plans it.
const STUCK_PLANNING_MS = Number(process.env.GOAL_STUCK_PLANNING_MS ?? 300_000); // 5 min
// Cap goals planned per sweep tick — a coarse rate limit until real budgets land.
const SWEEP_BATCH = Number(process.env.GOAL_SWEEP_BATCH ?? 20);
// Stall machinery: a goal whose ledger hasn't recorded forward progress within
// this window — yet still has open, non-done tasks (work is supposedly
// happening) — counts as stalled. After STALL_REPLAN_THRESHOLD consecutive
// stalled sweeps, auto re-plan; after MAX_REPLANS, hand it to a human.
const STALL_WINDOW_MS = Number(process.env.GOAL_STALL_WINDOW_MS ?? 900_000); // 15 min
const STALL_REPLAN_THRESHOLD = Number(process.env.GOAL_STALL_REPLAN_THRESHOLD ?? 3);
const MAX_REPLANS = Number(process.env.GOAL_MAX_REPLANS ?? 2);
// Loop machinery: an ACTIVE goal (recent touches) that keeps repeating the same
// step without advancing is "in a loop" — caught by the typed Progress Ledger,
// not the wall-clock stall gate. After this many consecutive in-loop sweeps it
// escalates the same way a stall does (notify, or re-plan if GOAL_STALL_REPLAN).
const LOOP_REPLAN_THRESHOLD = Number(process.env.GOAL_LOOP_REPLAN_THRESHOLD ?? 2);
// Review-queue SLA: a task sitting in `review` longer than this with nobody
// flipping it has fallen through the cracks — escalate to a human so the board
// doesn't freeze with finished-but-uncertified work (3 tasks sat 30h+ in
// practice). Dedup is via touching updated_at, so a task re-escalates at most
// once per SLA period.
const REVIEW_SLA_MS = Number(process.env.REVIEW_SLA_MS ?? 6 * 60 * 60 * 1000); // 6h

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

  // NOTE: the stall/loop pass (step 3) MUST run every sweep, independently of
  // whether there are unplanned OPEN goals to enqueue. An earlier version
  // `return`ed here when `candidates` was empty — the steady state once every
  // goal is planned and in_progress — which silently disabled stall/loop
  // detection entirely (the ledger's progress assessment froze and the
  // credential-begging loop was never caught). Only the enqueue step is gated
  // on candidates; the assessment always runs.
  if (candidates.length) {
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

  // 3. Stall/loop detection + per-round progress assessment. Runs EVERY sweep.
  await handleStalls().catch((e) => console.error("[goal-planner] stall pass error", e));

  // 4. Review-queue SLA: escalate review tasks nobody has certified.
  await handleReviewQueue().catch((e) => console.error("[goal-planner] review pass error", e));
}

// Escalate tasks stuck in `review` past the SLA to a human, so finished work
// doesn't rot uncertified. The reviewer was already woken on review entry; this
// is the backstop for when that wake was missed or ignored. Touches updated_at
// to dedup (re-fires at most once per SLA window). Notifies a HUMAN only — the
// goal owner if human, else the human task creator — never re-pings agents.
async function handleReviewQueue(): Promise<void> {
  const cutoff = new Date(Date.now() - REVIEW_SLA_MS);
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      workspaceId: tasks.workspaceId,
      createdBy: tasks.createdBy,
      goalOwner: goals.ownerMemberId,
    })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .leftJoin(goals, eq(goals.id, tasks.goalId))
    .where(
      and(
        eq(tasks.status, "review"),
        eq(tasks.archived, false),
        lt(tasks.updatedAt, cutoff),
        eq(workspaces.autoPlan, "auto"),
      ),
    )
    .limit(SWEEP_BATCH);

  for (const r of rows) {
    // Prefer the goal owner, fall back to the task creator; only notify if it's
    // a human member (agents were already woken on review entry).
    for (const candidate of [r.goalOwner, r.createdBy]) {
      if (!candidate) continue;
      const [m] = await db.select({ kind: members.kind }).from(members).where(eq(members.id, candidate)).limit(1);
      if (m?.kind !== "user") continue;
      await notify({
        workspaceId: r.workspaceId,
        memberId: candidate,
        kind: "system",
        title: "A task has been waiting for review",
        body: `${r.title} — finished and awaiting sign-off for over ${Math.round(REVIEW_SLA_MS / 3_600_000)}h. Review it and mark it done, or send it back.`,
        link: `/board?task=${r.id}`,
      }).catch(() => {});
      break;
    }
    // Touch updated_at so it won't re-escalate until another SLA window passes.
    await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, r.id)).catch(() => {});
  }
  if (rows.length) console.log(`[goal-planner] review SLA: escalated ${rows.length} stale review task(s)`);
}

// Per-sweep progress assessment + escalation. Every in-progress goal (active OR
// quiet) gets a fresh typed Progress Ledger (is_progress_being_made / is_in_loop)
// written so agents read it on their next wake. Two escalation triggers share
// one path:
//   • STALL — ledger lastProgressAt older than the window (the team went quiet),
//     counted per-sweep, fires at STALL_REPLAN_THRESHOLD.
//   • LOOP  — the team is ACTIVE but repeating itself without advancing, fires
//     at LOOP_REPLAN_THRESHOLD consecutive in-loop sweeps. This catches the
//     echo-loop the wall-clock gate misses.
// Escalation = re-plan when GOAL_STALL_REPLAN=on (destructive, capped by
// MAX_REPLANS); otherwise the SAFE DEFAULT is to notify the owner once.
async function handleStalls(): Promise<void> {
  const cutoffMs = Date.now() - STALL_WINDOW_MS;
  const rows = await db
    .select({
      led: goalLedgers,
      ownerMemberId: goals.ownerMemberId,
      createdBy: goals.createdBy,
      title: goals.title,
    })
    .from(goalLedgers)
    .innerJoin(goals, eq(goals.id, goalLedgers.goalId))
    .innerJoin(workspaces, eq(workspaces.id, goalLedgers.workspaceId))
    .where(and(eq(goals.status, "in_progress"), eq(workspaces.autoPlan, "auto")))
    .limit(SWEEP_BATCH);

  let assessed = 0;
  let flagged = 0;
  for (const r of rows) {
    const led = r.led;
    // Per-goal task counts (done vs still-open). No open work → awaiting roll-up,
    // not a stall/loop; skip (but don't assess — nothing to advance).
    const [counts] = await db
      .select({
        done: dsql<number>`count(*) filter (where ${tasks.status} = 'done')`.as("done"),
        open: dsql<number>`count(*) filter (where ${tasks.status} <> 'done')`.as("open"),
      })
      .from(tasks)
      .where(and(eq(tasks.goalId, led.goalId), eq(tasks.archived, false)));
    const doneCount = Number(counts?.done ?? 0);
    const openCount = Number(counts?.open ?? 0);
    if (openCount === 0) continue;

    const lastActivityMs = Date.now() - led.lastProgressAt.getTime();
    const { pl, nextLoopCount } = assessProgress(led, { doneCount, openCount, lastActivityMs }, STALL_WINDOW_MS);
    await writeProgressAssessment(led.goalId, pl, nextLoopCount);
    assessed++;

    const quietStalled = led.lastProgressAt.getTime() < cutoffMs;
    const looping = nextLoopCount >= LOOP_REPLAN_THRESHOLD;
    if (!quietStalled && !looping) continue;
    flagged++;

    // Only the quiet path increments the wall-clock stall counter (preserve the
    // original semantics); the loop path escalates on its own counter.
    const stallCount = quietStalled ? await bumpStall(led.goalId) : led.stallCount;
    if (!looping && stallCount < STALL_REPLAN_THRESHOLD) continue;

    await escalateStuck({
      goalId: led.goalId,
      workspaceId: led.workspaceId,
      replanCount: led.replanCount,
      ownerMemberId: r.ownerMemberId,
      createdBy: r.createdBy,
      title: r.title,
      reason: looping ? "loop" : "stall",
    });
  }
  if (assessed || flagged) {
    console.log(`[goal-planner] stall pass: assessed=${assessed} flagged=${flagged} of ${rows.length} in-progress goal(s)`);
  }
}

// Notify-or-replan a goal that's stalled or looping. Re-plan only under the
// GOAL_STALL_REPLAN opt-in (it ARCHIVES open tasks — destructive, and a slow-
// but-working team could be misread); the safe default notifies the owner once.
async function escalateStuck(g: {
  goalId: string;
  workspaceId: string;
  replanCount: number;
  ownerMemberId: string | null;
  createdBy: string;
  title: string;
  reason: "stall" | "loop";
}): Promise<void> {
  const autoReplan = process.env.GOAL_STALL_REPLAN === "on";
  if (!autoReplan || g.replanCount >= MAX_REPLANS) {
    if (g.ownerMemberId) {
      const capped = g.replanCount >= MAX_REPLANS ? ` (and ${MAX_REPLANS} auto re-plans didn't help)` : "";
      await notify({
        workspaceId: g.workspaceId,
        memberId: g.ownerMemberId,
        kind: "system",
        title: g.reason === "loop" ? "A goal is looping — needs your input" : "A goal looks stalled — needs your input",
        body:
          g.reason === "loop"
            ? `${g.title} — the team keeps repeating the same step without progress${capped}. Re-scope it or unblock them.`
            : `${g.title} has shown no task progress for a while${capped}. Re-scope it or unblock the team.`,
        link: `/goals`,
      }).catch(() => {});
    }
    // Reset both counters so we don't re-notify every sweep.
    await db
      .update(goalLedgers)
      .set({ stallCount: 0, loopCount: 0, lastProgressAt: new Date(), updatedAt: new Date() })
      .where(eq(goalLedgers.goalId, g.goalId));
    return;
  }

  console.log(`[goal-planner] goal ${g.goalId} ${g.reason} → re-planning`);
  await planGoal({
    goalId: g.goalId,
    workspaceId: g.workspaceId,
    actorMemberId: g.ownerMemberId ?? g.createdBy,
    isReplan: true,
  }).catch((e) => console.error("[goal-planner] re-plan failed", g.goalId, e));
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
