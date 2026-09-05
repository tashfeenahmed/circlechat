// Run accounting — turn what a runtime actually did into an honest
// agent_runs.status / error_text, and decide how hard to back off an agent's
// scheduled heartbeat when it keeps producing nothing.
//
// Before this, EVERY run that didn't throw at the transport layer was written
// as status=ok with error_text=null — including runs where the bridge crashed
// and returned an empty reply, runs whose every action was rejected by the
// reply guard, and runaway turns that hit the runtime's max-iterations cap and
// posted a "⚠️ Reached maximum iterations" banner. 1,466 rows / 7 days on the
// fishbowl, all ok, while the bridge log was full of skips. The stuck detector
// and run reaper key on status/error_text, so they had nothing to act on.
//
// Pure functions only (no db/redis) so they are unit-testable; the worker and
// scheduler wire them to storage.

export interface RunResponseLike {
  actions: unknown[];
  trace?: string[];
  // Optional explicit failure reason from the runtime/bridge (e.g. "empty_reply").
  error?: string;
}

export interface ApplyOutcomeLike {
  actionsApplied: number;
  errors: string[];
}

export type RunClass =
  | { status: "ok"; productive: true; errorText: null }
  | { status: "ok"; productive: false; errorText: null; idle: true }
  | { status: "failed"; productive: false; errorText: string };

// Hermes/OpenClaw print this when the agent loop hits max_turns without
// finishing; the bridge forwards it as ordinary prose, so it lands in a
// post_message / task_comment body.
export const RUNAWAY_BANNER_RE = /reached maximum iterations\s*\(\d+\)/i;
// The bridge's catch-all trace line: `${handle} error: ${message}`.
const BRIDGE_ERROR_TRACE_RE = /^\S+ error: (.+)$/;

function bodyOf(action: unknown): string {
  if (!action || typeof action !== "object") return "";
  const a = action as Record<string, unknown>;
  return typeof a.body_md === "string" ? a.body_md : "";
}

export function classifyRunOutcome(
  response: RunResponseLike | "HEARTBEAT_OK",
  outcome: ApplyOutcomeLike,
): RunClass {
  if (response === "HEARTBEAT_OK") return { status: "ok", productive: false, errorText: null, idle: true };

  if (response.error) {
    return { status: "failed", productive: false, errorText: response.error.slice(0, 500) };
  }

  const traceErr = (response.trace ?? []).map((l) => BRIDGE_ERROR_TRACE_RE.exec(String(l))).find(Boolean);
  if (traceErr) {
    return { status: "failed", productive: false, errorText: `bridge_error: ${traceErr[1].slice(0, 400)}` };
  }

  if (response.actions.some((a) => RUNAWAY_BANNER_RE.test(bodyOf(a)))) {
    return { status: "failed", productive: false, errorText: "runaway_max_iterations" };
  }

  if (response.actions.length > 0 && outcome.actionsApplied === 0) {
    const first = outcome.errors[0] ?? "no action applied";
    return {
      status: "failed",
      productive: false,
      errorText: `all_actions_rejected: ${first.slice(0, 400)}`,
    };
  }

  if (outcome.actionsApplied > 0) return { status: "ok", productive: true, errorText: null };
  return { status: "ok", productive: false, errorText: null, idle: true };
}

// Exponential heartbeat backoff for an agent whose scheduled runs keep coming
// back non-productive (idle, failed, rejected). Returns how long the NEXT
// scheduled tick should be suppressed for. Streak 0–1 → no backoff (one quiet
// beat is normal); from 2 on it doubles the base interval each time, capped.
export function heartbeatBackoffMs(streak: number, baseMs: number, capMs: number): number {
  if (!Number.isFinite(streak) || streak < 2) return 0;
  const base = Math.max(1_000, baseMs);
  const cap = Math.max(base, capMs);
  const factor = Math.pow(2, Math.min(streak - 1, 20));
  return Math.min(cap, Math.round(base * factor));
}
