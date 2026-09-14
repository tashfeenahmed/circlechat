// The ONE place a goal's status is written.
//
// Why this exists. `goals.status` was being set from five different places —
// updateGoal (the API), the planner (open → planning → in_progress / back to
// open on failure), the completion roll-up in tasks-core, the sweeper's
// stuck-planning recovery, and the auto-parking pass in goal-planner-worker —
// and only ONE of them (updateGoal) wrote an audit event. So on live, every
// goal that was auto-parked or rolled up to `done` changed state with no row in
// `audit_events` at all: the enterprise audit export showed a board where goals
// apparently never moved. Worse, the one writer that DID audit hardcoded
// nothing for actor_type, so `audit()`'s fallback stamped "user" on every
// transition an AGENT member caused.
//
// Everything goes through setGoalStatus() now: it claims the row with a
// status-guarded UPDATE (so two sweeps can't both "park" the same goal and
// double-audit it), derives actor_type from the member's own kind, writes the
// audit event, and publishes the goal.updated frame.
//
// The pure helpers (auditActorType, goalParkedBody) carry the logic worth
// testing without a database.
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { goals, members } from "../db/schema.js";
import { audit } from "./audit.js";
import { publishToWorkspace } from "./events.js";

/** Why a goal moved. Recorded in the audit meta so the trail reads as a story. */
export type GoalStatusReason =
  | "manual" // a member changed it from the API / Goals page
  | "park" // the auto-parking sweep
  | "resume" // a parked goal put back to work
  | "complete" // the completion roll-up: every task and child goal is done
  | "archive"
  | "plan_started" // planner: open → planning
  | "plan_failed" // planner: planning → open (generation failed / empty / cyclic)
  | "planned" // planner: tasks materialised → in_progress
  | "plan_recovered"; // sweeper: a goal stuck in `planning` after a worker death

/**
 * Pure: the audit actor_type for a goal status change, derived from the
 * MEMBER's kind rather than assumed. `members.kind` is "user" | "agent"; a
 * sweep with no member behind it is "system". An actor we cannot resolve stays
 * "user" (the id is still recorded) — we only ever claim "agent" when the
 * member row says so.
 */
export function auditActorType(
  memberKind: string | null | undefined,
  actorId?: string | null,
): "user" | "agent" | "system" {
  if (!actorId || actorId === "system") return "system";
  const k = (memberKind || "").trim().toLowerCase();
  if (k === "agent") return "agent";
  return "user";
}

export interface GoalStatusWrite {
  goalId: string;
  workspaceId: string;
  /** The status to move to. */
  to: string;
  /** Member id of whoever caused it; null/"system" for sweeps and roll-ups. */
  actorMemberId?: string | null;
  reason: GoalStatusReason;
  /** Extra audit meta (kept small by audit()'s clampMeta). */
  meta?: Record<string, unknown>;
  /**
   * Publish a `goal.updated` frame. Default true; callers that publish their
   * own hydrated frame (updateGoal) pass false so the board sees one event.
   */
  publish?: boolean;
}

export interface GoalStatusResult {
  changed: boolean;
  from: string | null;
}

/**
 * Move a goal to a new status, once, with an audit row. Returns `changed:false`
 * (and writes nothing) when the goal is missing, belongs to another workspace,
 * is already in that status, or was moved by someone else between the read and
 * the write — which is what makes it safe to call from every sweep tick.
 */
export async function setGoalStatus(w: GoalStatusWrite): Promise<GoalStatusResult> {
  const [g] = await db
    .select({ status: goals.status, title: goals.title, workspaceId: goals.workspaceId })
    .from(goals)
    .where(eq(goals.id, w.goalId))
    .limit(1);
  if (!g || g.workspaceId !== w.workspaceId) return { changed: false, from: null };
  if (g.status === w.to) return { changed: false, from: g.status };

  // Status-guarded: whoever loses the race writes nothing and audits nothing.
  const claimed = await db
    .update(goals)
    .set({ status: w.to, updatedAt: new Date() })
    .where(and(eq(goals.id, w.goalId), eq(goals.status, g.status)))
    .returning({ id: goals.id });
  if (!claimed.length) return { changed: false, from: g.status };

  const actorId = w.actorMemberId || "system";
  let kind: string | null = null;
  if (actorId !== "system") {
    const [m] = await db
      .select({ kind: members.kind })
      .from(members)
      .where(and(eq(members.id, actorId), eq(members.workspaceId, w.workspaceId)))
      .limit(1)
      .catch(() => [] as Array<{ kind: string }>);
    kind = m?.kind ?? null;
  }
  await audit({
    workspaceId: w.workspaceId,
    actorId,
    actorType: auditActorType(kind, actorId),
    action: "goal.status_changed",
    targetType: "goal",
    targetId: w.goalId,
    meta: { from: g.status, to: w.to, reason: w.reason, title: g.title, ...(w.meta ?? {}) },
  });

  if (w.publish !== false) {
    await publishToWorkspace(w.workspaceId, {
      type: "goal.updated",
      workspaceId: w.workspaceId,
      goalId: w.goalId,
      status: w.to,
    }).catch(() => {});
  }
  return { changed: true, from: g.status };
}

// ───────────────── parked-goal notification copy ─────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-08-28` — unambiguous, and the only date format the copy ever uses. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure: the body of the "a goal was parked" notification.
 *
 * The live copy said "nothing on it has moved in 0+ days" — it rendered the
 * CONFIGURED window (GOAL_PARK_AFTER_MS, rounded to days) rather than how long
 * the goal had actually been quiet, so a short window rounded to zero and the
 * owner was told a goal was parked for going nowhere for no time at all. Use
 * the real elapsed time, and below a day say WHEN instead of how long. "0+
 * days" is unreachable from here.
 */
export function goalParkedBody(title: string, lastMovedAt: Date | null, now: number = Date.now()): string {
  const tail =
    ", so it has been parked and the team has stopped working on it. Resume it from Goals when it matters again.";
  const ms = lastMovedAt ? now - lastMovedAt.getTime() : NaN;
  if (!Number.isFinite(ms) || ms < 0) {
    return `${title} — it has no recorded activity at all${tail}`;
  }
  const days = Math.floor(ms / DAY_MS);
  const since = isoDay(lastMovedAt!);
  if (days >= 1) {
    return `${title} — nothing on it has moved for ${days} day${days === 1 ? "" : "s"} (since ${since})${tail}`;
  }
  return `${title} — nothing on it has moved since ${since}${tail}`;
}
