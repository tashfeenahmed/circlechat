// Human-facing copy for the "Needs you" queue. Pure string builders, kept out
// of the route so they can be unit tested without touching the DB.

// Shown instead of the judge's raw rationale on the public read-only demo. The
// rationale is written for the reviewer agent — it quotes rubric wording, file
// paths and tool names — so a visitor gets the fact, not the machinery.
export const SPECTATOR_VERIFICATION_DETAIL =
  "An automated check flagged this deliverable — open the card to see what is missing.";

// "3 stalled assessment(s); 1 re-plan(s)" counted the planner's own bookkeeping;
// nobody can act on it. What a human wants is how long the goal has sat still.
// Fixed month names rather than toLocaleDateString: the ICU short form for
// September is "Sept" on some Node builds and "Sep" on others, and this string
// is asserted in tests and read on the public demo.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function stalledDetail(updatedAt: Date): string {
  return `No movement since ${updatedAt.getUTCDate()} ${MONTHS[updatedAt.getUTCMonth()]}.`;
}

// ─────────────── what the public demo's queue shows ───────────────
// "Needs you" is a to-do list for the person who owns the workspace. On
// live.circlechat.co it is served to anonymous visitors, who cannot act on any
// of it — and what they were reading was mostly nagging: 4 of 7 items were
// `stalled_goal` rows, the oldest for a goal untouched for 72 days, sitting
// next to `verification_failed` cards whose deliverable is demonstrably on
// disk (the judge was unreachable, not the work missing).
//
// So the spectator view answers a different question — "what is waiting on a
// human right now?" — with three rules:
//   1. no `stalled_goal`: a goal nobody has touched since July is a fact about
//      this workspace's backlog, not something a visitor can act on;
//   2. nothing older than 72 h: a queue full of months-old rows reads as
//      abandoned, and an item that has waited that long is not "needs you";
//   3. no `verification_failed` for a card that HAS a verified deliverable —
//      those rows were the judge-outage false negatives, and the card's own
//      review item still shows.
// Logged-in members see the queue unchanged.

export const SPECTATOR_MAX_ITEM_AGE_MS = 72 * 60 * 60 * 1000;

export interface QueueItemLike {
  kind: string;
  createdAt: string;
  targetId: string;
}

// Pure: apply the spectator rules to an already-built queue. `verifiedTaskIds`
// is the set of task ids that carry a verified deliverable.
export function filterForSpectator<T extends QueueItemLike>(
  items: T[],
  verifiedTaskIds: ReadonlySet<string>,
  now: number = Date.now(),
): T[] {
  return items.filter((item) => {
    if (item.kind === "stalled_goal") return false;
    const age = now - Date.parse(item.createdAt);
    if (Number.isFinite(age) && age > SPECTATOR_MAX_ITEM_AGE_MS) return false;
    if (item.kind === "verification_failed" && verifiedTaskIds.has(item.targetId)) return false;
    return true;
  });
}
