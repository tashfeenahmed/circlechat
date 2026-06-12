import { describe, it, expect } from "vitest";
import { assessProgress } from "../lib/ledger-core.js";
import type { GoalLedger } from "../db/schema.js";

// assessProgress is the deterministic core of stall/loop detection: progress
// is "the done-count or note stream advanced since the last sweep", a loop is
// "active + repetitive + not advancing". Pin the four behaviors that matter.

const HOUR = 60 * 60 * 1000;

function ledger(overrides: Partial<GoalLedger> = {}): GoalLedger {
  return {
    goalId: "goal_1",
    facts: [],
    deadEnds: [],
    progressNotes: [],
    plan: "",
    loopCount: 0,
    progressLedger: null,
    lastProgressAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as GoalLedger;
}

function notes(...texts: string[]) {
  return texts.map((note, i) => ({ by: "agent", note, ts: new Date(2026, 0, i + 1).toISOString() }));
}

describe("assessProgress", () => {
  it("first assessment (no stored signal) counts as progress", () => {
    const { pl, nextLoopCount } = assessProgress(
      ledger(),
      { doneCount: 0, openCount: 3, lastActivityMs: HOUR },
      2 * HOUR,
    );
    expect(pl.isProgressBeingMade).toBe(true);
    expect(pl.isInLoop).toBe(false);
    expect(nextLoopCount).toBe(0);
  });

  it("all tasks done means the request is satisfied", () => {
    const { pl } = assessProgress(
      ledger(),
      { doneCount: 5, openCount: 0, lastActivityMs: HOUR },
      2 * HOUR,
    );
    expect(pl.isRequestSatisfied).toBe(true);
    expect(pl.nextStep).toContain("close the goal");
  });

  it("unchanged signal with repetitive recent notes while active = loop", () => {
    // LOOP_WINDOW is 4: repetition only counts with a full window of
    // near-identical notes.
    const repeated = notes(
      "retrying the deploy",
      "retrying the deploy",
      "retrying the deploy",
      "retrying the deploy",
    );
    const led = ledger({ progressNotes: repeated, loopCount: 1 });
    // Prime the stored signal to exactly what this state computes, so
    // "nothing advanced since last sweep" holds.
    const first = assessProgress(led, { doneCount: 0, openCount: 2, lastActivityMs: HOUR }, 2 * HOUR);
    const ledWithSignal = ledger({
      progressNotes: repeated,
      loopCount: 1,
      progressLedger: first.pl,
    });
    const { pl, nextLoopCount } = assessProgress(
      ledWithSignal,
      { doneCount: 0, openCount: 2, lastActivityMs: HOUR },
      2 * HOUR,
    );
    expect(pl.isProgressBeingMade).toBe(false);
    expect(pl.isInLoop).toBe(true);
    expect(nextLoopCount).toBe(2);
    expect(pl.nextStep).toContain("STOP");
  });

  it("stale goals (inactive) are stalled, not looping", () => {
    const repeated = notes(
      "retrying the deploy",
      "retrying the deploy",
      "retrying the deploy",
      "retrying the deploy",
    );
    const led = ledger({ progressNotes: repeated });
    const first = assessProgress(led, { doneCount: 0, openCount: 2, lastActivityMs: HOUR }, 2 * HOUR);
    const { pl, nextLoopCount } = assessProgress(
      ledger({ progressNotes: repeated, progressLedger: first.pl }),
      { doneCount: 0, openCount: 2, lastActivityMs: 10 * HOUR }, // inactive
      2 * HOUR,
    );
    expect(pl.isInLoop).toBe(false);
    expect(nextLoopCount).toBe(0);
  });

  it("a new done-task resets the loop counter", () => {
    const repeated = notes(
      "retrying the deploy",
      "retrying the deploy",
      "retrying the deploy",
      "retrying the deploy",
    );
    const led = ledger({ progressNotes: repeated, loopCount: 3 });
    const first = assessProgress(led, { doneCount: 1, openCount: 2, lastActivityMs: HOUR }, 2 * HOUR);
    const { pl, nextLoopCount } = assessProgress(
      ledger({ progressNotes: repeated, loopCount: 3, progressLedger: first.pl }),
      { doneCount: 2, openCount: 1, lastActivityMs: HOUR }, // done advanced
      2 * HOUR,
    );
    expect(pl.isProgressBeingMade).toBe(true);
    expect(nextLoopCount).toBe(0);
  });
});
