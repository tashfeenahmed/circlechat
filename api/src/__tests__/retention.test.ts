import { describe, it, expect } from "vitest";
import {
  cutoffDate,
  effectiveRetentionDays,
  retentionWindows,
  shouldRunNow,
  staleRepeatableKeys,
  withinDoneWindow,
} from "../lib/retention.js";

// Live numbers that motivated each window: 43,423 notification rows, a 191 MB
// agent_runs table (180 MB of it context_json), Done cards from July still on
// the board, and 506 orphaned BullMQ repeat templates under `noeviction`.

describe("retentionWindows", () => {
  it("defaults match the documented policy", () => {
    const w = retentionWindows({});
    expect(w.notificationReadDays).toBe(30);
    expect(w.notificationUnreadSystemDays).toBe(90);
    expect(w.runContextDays).toBe(7);
    expect(w.runDeleteDays).toBe(90);
    expect(w.doneArchiveDays).toBe(7);
  });

  it("reads overrides from the environment", () => {
    const w = retentionWindows({ CC_RUN_RETENTION_DAYS: "14", CC_DONE_ARCHIVE_DAYS: "3" });
    expect(w.runDeleteDays).toBe(14);
    expect(w.doneArchiveDays).toBe(3);
  });

  it("ignores junk and zero rather than deleting everything", () => {
    const w = retentionWindows({ CC_RUN_RETENTION_DAYS: "0", CC_DONE_ARCHIVE_DAYS: "nope" });
    expect(w.runDeleteDays).toBe(90);
    expect(w.doneArchiveDays).toBe(7);
  });
});

describe("effectiveRetentionDays", () => {
  it("uses the deployment default when the workspace sets nothing", () => {
    expect(effectiveRetentionDays(7, null)).toBe(7);
    expect(effectiveRetentionDays(7, undefined)).toBe(7);
  });

  it("honours a workspace retention_days in both directions", () => {
    expect(effectiveRetentionDays(7, 3)).toBe(3);
    expect(effectiveRetentionDays(90, 365)).toBe(365);
  });

  it("falls back on a nonsensical workspace value", () => {
    expect(effectiveRetentionDays(7, 0)).toBe(7);
    expect(effectiveRetentionDays(7, -5)).toBe(7);
    expect(effectiveRetentionDays(7, Number.NaN)).toBe(7);
  });
});

describe("cutoffDate", () => {
  it("subtracts whole days", () => {
    const now = new Date("2026-09-14T12:00:00.000Z");
    expect(cutoffDate(now, 7).toISOString()).toBe("2026-09-07T12:00:00.000Z");
  });
});

describe("staleRepeatableKeys", () => {
  const jobs = [
    { key: "hb:a_live:::60000", name: "hb:a_live" },
    { key: "hb:a_gone:::60000", name: "hb:a_gone" },
    { key: "hb:a_gone2:::60000", name: "hb:a_gone2" },
    { key: "goal-sweep:::180000", name: "goal-sweep" },
  ];

  it("removes heartbeats whose agent no longer exists", () => {
    expect(staleRepeatableKeys(jobs, ["a_live"])).toEqual([
      "hb:a_gone:::60000",
      "hb:a_gone2:::60000",
    ]);
  });

  it("never touches a live agent's heartbeat", () => {
    expect(staleRepeatableKeys(jobs, ["a_live", "a_gone", "a_gone2"])).toEqual([]);
  });

  it("leaves non-heartbeat repeatables alone", () => {
    expect(staleRepeatableKeys(jobs, [])).not.toContain("goal-sweep:::180000");
  });
});

describe("withinDoneWindow", () => {
  const now = Date.parse("2026-09-14T00:00:00.000Z");
  const day = 24 * 3600 * 1000;
  const card = (status: string, ageDays: number, archived = false) => ({
    status,
    archived,
    updatedAt: new Date(now - ageDays * day),
  });

  it("with no window every non-archived card passes", () => {
    expect(withinDoneWindow(card("done", 400), null, now)).toBe(true);
  });

  it("archived cards are never visible, window or not", () => {
    expect(withinDoneWindow(card("done", 1, true), null, now)).toBe(false);
    expect(withinDoneWindow(card("in_progress", 1, true), 14 * day, now)).toBe(false);
  });

  it("only the done column is capped", () => {
    expect(withinDoneWindow(card("in_progress", 400), 14 * day, now)).toBe(true);
    expect(withinDoneWindow(card("backlog", 400), 14 * day, now)).toBe(true);
  });

  it("done cards inside the window pass, older ones do not", () => {
    expect(withinDoneWindow(card("done", 13), 14 * day, now)).toBe(true);
    expect(withinDoneWindow(card("done", 15), 14 * day, now)).toBe(false);
  });
});

describe("shouldRunNow", () => {
  it("runs on the first call after boot", () => {
    expect(shouldRunNow(null, 1_000, 3_600_000)).toBe(true);
  });

  it("waits out the interval, then runs", () => {
    expect(shouldRunNow(1_000, 1_000 + 60_000, 3_600_000)).toBe(false);
    expect(shouldRunNow(1_000, 1_000 + 3_600_000, 3_600_000)).toBe(true);
  });
});
