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
