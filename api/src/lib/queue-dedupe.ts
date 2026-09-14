// Fixed-jobId dedupe, done safely.
//
// BullMQ treats a custom `jobId` as an existence key, not a "one at a time"
// lock: `addStandardJob` does `EXISTS <prefix><jobId>` and, if the key is
// there, returns the existing id and adds NOTHING. The key survives after the
// job finishes, for as long as the job stays in the completed/failed set
// (`removeOnComplete: 200` keeps the last 200).
//
// So a fixed jobId that is meant to mean "only one of these pending at a time"
// silently becomes "only one of these EVER, until the completed set rotates".
// On live this black-holed goal planning: a plan job that returned early
// (a deferred plan, or one whose LLM gateway was unreachable, both of which
// COMPLETE rather than fail) sat in the completed set, and the 3-minute
// sweeper's re-enqueue for that goal was discarded every tick. Two open goals
// went 70 minutes unplanned until the completed jobs were deleted by hand.
//
// The rule: dedupe against IN-FLIGHT work only. A finished job must never be
// allowed to block a fresh attempt.

export type JobState =
  | "completed"
  | "failed"
  | "delayed"
  | "active"
  | "waiting"
  | "waiting-children"
  | "prioritized"
  | "unknown";

/**
 * Pure decision: given the state of the job already holding this jobId, must it
 * be removed before `add()` can be expected to enqueue anything?
 *
 *   completed / failed → yes. It is finished; keeping it only blocks retries.
 *   waiting / active / delayed / prioritized / waiting-children → no. That is
 *     real in-flight work and the whole point of the fixed id: don't pile up.
 *   unknown → no. BullMQ reports `unknown` for an id it has no record of
 *     (already removed, or never added), so there is nothing to remove and the
 *     add will go through on its own.
 */
export function shouldRemoveBeforeAdd(state: JobState | string | null | undefined): boolean {
  return state === "completed" || state === "failed";
}

/** The minimum of BullMQ's Queue surface this helper needs (keeps it testable). */
interface JobLike {
  getState(): Promise<string>;
  remove(): Promise<unknown>;
}
interface QueueLike {
  name: string;
  getJob(jobId: string): Promise<JobLike | undefined | null>;
}

/**
 * Clear a FINISHED job squatting on `jobId` so a subsequent `add()` with that
 * same id is not silently dropped. Returns true if something was removed.
 *
 * Call this before any `add()` that uses a fixed (non-unique) jobId. It is a
 * no-op when the id is free or the existing job is still in flight.
 */
export async function clearFinishedJob(queue: QueueLike, jobId: string): Promise<boolean> {
  try {
    const job = await queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (!shouldRemoveBeforeAdd(state)) return false;
    await job.remove();
    return true;
  } catch (e) {
    // Never let housekeeping stop the enqueue itself — if redis is genuinely
    // down the add below will throw with a much better message.
    console.warn(`[queue:${queue.name}] could not clear finished job ${jobId}:`, (e as Error)?.message ?? e);
    return false;
  }
}
