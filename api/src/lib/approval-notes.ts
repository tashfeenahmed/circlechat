// Pure text + decision helpers for the approval lifecycle.
//
// These live apart from approval-policy.ts on purpose: that module pulls in the
// DB, the event bus and the BullMQ queues, so importing it from a unit test
// drags a Redis/Postgres client into the test process. Everything here is
// dependency-free and safe to import anywhere.

// The dead-end line written into a goal's ledger when one of its approvals is
// closed for good. The ledger is injected into every agent wake, so this is
// what actually stops the team re-citing a dead card — the approval row going
// to `expired` is invisible to an agent whose brief still says "blocked on
// ap_…". Deterministic text so appendDeadEnd's dedupe keeps exactly one copy.
export function approvalDeadEndNote(
  approvalId: string,
  scope: string,
  outcome: "expired" | "denied",
): string {
  return (
    `Approval ${approvalId} (${scope || "unscoped"}) is ${outcome} and is NOT a live blocker. ` +
    `Do not cite it, wait on it, or re-request it — route around it.`
  );
}

// One line per sweep so "is the expiry sweep actually running?" is answerable
// from the logs. On live, all five pending approvals carried the SAME
// decided_at (the 5 Sep deploy) and 72h of worker logs contained no approval
// line at all — there was no way to tell a silent healthy sweep from a sweep
// that had stopped. A sweep that expires nothing logs a heartbeat at most once
// per SWEEP_HEARTBEAT_MS; a sweep that expires something always logs.
export const SWEEP_HEARTBEAT_MS = 30 * 60 * 1000;

/** Pure: is it time for another "the sweep ran" line? */
export function shouldLogSweepHeartbeat(
  nowMs: number,
  lastMs: number,
  intervalMs: number = SWEEP_HEARTBEAT_MS,
): boolean {
  return nowMs - lastMs > intervalMs;
}
