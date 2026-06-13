// Run-level stuck detection, modeled on OpenHands' controller/stuck.py. The
// goal ledger detects per-GOAL stalls and checkRecentDuplicate catches a
// repeated message within one conversation; this catches an AGENT stuck in a
// tight behavioral loop across its recent RUNS — including the A-B-A-B
// alternation that a "last message identical" check misses (e.g. post X →
// update Y → post X → update Y forever).
//
// Equality is on a NORMALIZED signature of what a run actually did (its action
// trace + error reasons with volatile ids stripped), not raw text — so the
// same action on different ids still counts as a repeat. Idle runs (no actions,
// HEARTBEAT_OK) produce a null signature and never count as a loop: returning
// "nothing to do" repeatedly is correct behavior, not a loop.

// Strip volatile ids so "update_task task_a" and "update_task task_b" share a
// signature. Mirrors the id-normalization used in the analytics error taxonomy.
const ID_RE = /\b(?:task|goal|ap|run|act|c|m|w|u|msg|cm|ntf|mbt|mbn|tver)_[a-z0-9]+\b/g;

export function normalizeRunSignature(
  traceLines: string[] | null | undefined,
  errorLines: string[] | null | undefined,
): string | null {
  const lines = [...(traceLines ?? []), ...(errorLines ?? [])];
  const parts = lines
    .map((l) =>
      String(l)
        .toLowerCase()
        .replace(ID_RE, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60),
    )
    .filter(Boolean);
  if (parts.length === 0) return null; // idle / HEARTBEAT_OK — not a loop
  return Array.from(new Set(parts)).sort().join("|");
}

export type StuckPattern = "repeat" | "alternate";
export type StuckResult =
  | { stuck: false }
  | { stuck: true; pattern: StuckPattern; signature: string };

// `signatures` is oldest → newest. nulls (idle runs) break a run of repeats.
//   • repeat:    the last 3 runs share one non-null signature.
//   • alternate: the last 4 runs are A,B,A,B with A≠B, both non-null.
export function detectStuck(signatures: Array<string | null>): StuckResult {
  const n = signatures.length;
  if (n >= 3) {
    const a = signatures[n - 3];
    const b = signatures[n - 2];
    const c = signatures[n - 1];
    if (a && a === b && b === c) return { stuck: true, pattern: "repeat", signature: a };
  }
  if (n >= 4) {
    const a = signatures[n - 4];
    const b = signatures[n - 3];
    const c = signatures[n - 2];
    const d = signatures[n - 1];
    if (a && b && a !== b && a === c && b === d) {
      return { stuck: true, pattern: "alternate", signature: `${a}  ⇄  ${b}` };
    }
  }
  return { stuck: false };
}

// One-shot corrective directive injected into the next run when an agent was
// detected looping (rendered by the bridge). Plain text; kept here so the
// wording lives next to the detector.
export function stuckBreakDirective(pattern: StuckPattern): string {
  const what =
    pattern === "alternate"
      ? "alternating between the same two steps without making progress"
      : "repeating the same step without making progress";
  return (
    `⚠ LOOP DETECTED — your last few runs have been ${what}. STOP doing that now. ` +
    `Do something genuinely DIFFERENT: take the next concrete step toward finishing the work, ` +
    `or if you're blocked on someone/something, set the task status to "blocked" with one clear ` +
    `note and STOP, or if there's nothing useful to do, reply with exactly "HEARTBEAT_OK". ` +
    `Do NOT repeat the action that triggered this warning.`
  );
}
