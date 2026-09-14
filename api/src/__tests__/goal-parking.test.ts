import { describe, it, expect } from "vitest";
import { GOAL_STATUSES, shouldParkGoal } from "../lib/goals-core.js";

// 9 of 11 in_progress goals on live were 17–72 days stale. Between them they
// produced every stall notification in the system and kept agents burning
// heartbeats on tasks nobody was going to look at.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-14T00:00:00.000Z");
const PARK_MS = 14 * DAY;
const daysAgo = (n: number) => new Date(NOW - n * DAY);

describe("GOAL_STATUSES", () => {
  it("includes parked, and it is neither open nor in_progress (so no planner query sees it)", () => {
    expect(GOAL_STATUSES).toContain("parked");
    expect(GOAL_STATUSES.indexOf("parked")).toBeGreaterThan(GOAL_STATUSES.indexOf("in_progress"));
  });
});

describe("shouldParkGoal", () => {
  it("parks an in_progress goal whose tasks have not moved in 14 days", () => {
    expect(
      shouldParkGoal(
        { status: "in_progress", lastTaskMovementAt: daysAgo(17), updatedAt: daysAgo(17) },
        NOW,
        PARK_MS,
      ),
    ).toBe(true);
  });

  it("leaves a goal with recent task movement alone", () => {
    expect(
      shouldParkGoal(
        { status: "in_progress", lastTaskMovementAt: daysAgo(2), updatedAt: daysAgo(30) },
        NOW,
        PARK_MS,
      ),
    ).toBe(false);
  });

  it("task movement wins over a stale goal row", () => {
    // The goal row's updatedAt is ancient but a task moved yesterday — the team
    // is working, the goal is alive.
    expect(
      shouldParkGoal(
        { status: "in_progress", lastTaskMovementAt: daysAgo(1), updatedAt: daysAgo(90) },
        NOW,
        PARK_MS,
      ),
    ).toBe(false);
  });

  it("falls back to the goal row when it has no tasks at all", () => {
    expect(
      shouldParkGoal({ status: "in_progress", lastTaskMovementAt: null, updatedAt: daysAgo(30) }, NOW, PARK_MS),
    ).toBe(true);
    expect(
      shouldParkGoal({ status: "in_progress", lastTaskMovementAt: null, updatedAt: daysAgo(3) }, NOW, PARK_MS),
    ).toBe(false);
  });

  it("is exactly at the boundary, not a day either side", () => {
    expect(
      shouldParkGoal({ status: "in_progress", lastTaskMovementAt: daysAgo(14), updatedAt: daysAgo(14) }, NOW, PARK_MS),
    ).toBe(true);
    expect(
      shouldParkGoal({ status: "in_progress", lastTaskMovementAt: daysAgo(13), updatedAt: daysAgo(13) }, NOW, PARK_MS),
    ).toBe(false);
  });

  it("only in_progress goals park", () => {
    for (const status of ["open", "planning", "parked", "done", "archived"]) {
      expect(
        shouldParkGoal({ status, lastTaskMovementAt: daysAgo(99), updatedAt: daysAgo(99) }, NOW, PARK_MS),
      ).toBe(false);
    }
  });

  it("never parks on an unreadable timestamp", () => {
    expect(
      shouldParkGoal(
        { status: "in_progress", lastTaskMovementAt: new Date("nonsense"), updatedAt: daysAgo(99) },
        NOW,
        PARK_MS,
      ),
    ).toBe(false);
  });
});
