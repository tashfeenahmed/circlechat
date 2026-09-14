import { describe, it, expect } from "vitest";
import { heartbeatBackoffMs, noopStreakBackoffMs } from "../lib/run-outcome.js";

// 1,568 scheduled runs over 14 days, 1,227 of them closed as
// {"skipped":"no_activity"} — a run row, two WS frames and a handful of queries
// each, for agents whose workspace had not changed. The heartbeat backoff only
// fires AFTER a run is materialised; this curve suppresses the tick before that.

const MIN = 60_000;
const CAP = 6 * 60 * MIN;

describe("noopStreakBackoffMs", () => {
  it("lets the first quiet ticks through — a silent workspace is normal", () => {
    expect(noopStreakBackoffMs(0, MIN, CAP)).toBe(0);
    expect(noopStreakBackoffMs(1, MIN, CAP)).toBe(0);
    expect(noopStreakBackoffMs(2, MIN, CAP)).toBe(0);
  });

  it("kicks in at the third consecutive no-op and doubles from there", () => {
    expect(noopStreakBackoffMs(3, MIN, CAP)).toBe(2 * MIN);
    expect(noopStreakBackoffMs(4, MIN, CAP)).toBe(4 * MIN);
    expect(noopStreakBackoffMs(5, MIN, CAP)).toBe(8 * MIN);
  });

  it("is more patient than the heartbeat backoff at the same streak", () => {
    expect(noopStreakBackoffMs(2, MIN, CAP)).toBeLessThan(heartbeatBackoffMs(2, MIN, CAP));
  });

  it("never exceeds the cap", () => {
    expect(noopStreakBackoffMs(50, MIN, CAP)).toBe(CAP);
    expect(noopStreakBackoffMs(1_000_000, MIN, CAP)).toBe(CAP);
  });

  it("respects a custom minimum streak", () => {
    expect(noopStreakBackoffMs(4, MIN, CAP, 5)).toBe(0);
    expect(noopStreakBackoffMs(5, MIN, CAP, 5)).toBe(2 * MIN);
  });

  it("survives junk input without suppressing forever", () => {
    expect(noopStreakBackoffMs(Number.NaN, MIN, CAP)).toBe(0);
    expect(noopStreakBackoffMs(-3, MIN, CAP)).toBe(0);
  });

  it("a cap below the base interval still yields at least the base", () => {
    expect(noopStreakBackoffMs(9, MIN, 1_000)).toBe(MIN);
  });
});
