import { describe, it, expect } from "vitest";
import { auditActorType, goalParkedBody } from "../lib/goal-status.js";
import { mergeDeadEnd } from "../lib/ledger-core.js";
import { approvalDeadEndNote } from "../lib/approval-notes.js";
import { backfillOutcomeFor } from "../lib/approval-policy.js";

// Goal status changes used to bypass the audit trail entirely: handleGoalParking
// and the completion roll-up wrote `goals.status` with a bare UPDATE, so live
// had parked and completed goals with ZERO rows in audit_events. The one writer
// that did audit (updateGoal) let audit()'s fallback stamp actor_type "user" on
// transitions an AGENT member caused.

describe("auditActorType", () => {
  it("says agent when the member row says agent", () => {
    expect(auditActorType("agent", "mem_1")).toBe("agent");
    expect(auditActorType("AGENT", "mem_1")).toBe("agent");
  });

  it("says user for a human member", () => {
    expect(auditActorType("user", "mem_1")).toBe("user");
  });

  it("says system for a sweep with no member behind it", () => {
    expect(auditActorType("agent", null)).toBe("system");
    expect(auditActorType(null, undefined)).toBe("system");
    expect(auditActorType(null, "system")).toBe("system");
  });

  it("never claims agent on an unresolvable member", () => {
    expect(auditActorType(null, "mem_gone")).toBe("user");
    expect(auditActorType("", "mem_gone")).toBe("user");
  });
});

describe("goalParkedBody", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-09-14T12:00:00.000Z");

  it("uses the REAL elapsed time, not the configured window", () => {
    const body = goalParkedBody("Ship the governance dashboard", new Date(now - 17 * DAY), now);
    expect(body).toContain("nothing on it has moved for 17 days");
    expect(body).toContain("since 2026-08-28");
  });

  it("never renders the live '0+ days' — it says since <date> instead", () => {
    // The live notification: "nothing on it has moved in 0+ days".
    const body = goalParkedBody("Ship it", new Date(now - 3 * 60 * 60 * 1000), now);
    expect(body).not.toMatch(/0\+? days?/);
    expect(body).not.toContain("0 days");
    expect(body).toContain("since 2026-09-14");
  });

  it("is never plural for exactly one day", () => {
    expect(goalParkedBody("Ship it", new Date(now - DAY), now)).toContain("for 1 day (since 2026-09-13)");
  });

  it("degrades honestly when there is no usable timestamp", () => {
    for (const bad of [null, new Date("nonsense"), new Date(now + DAY)]) {
      const body = goalParkedBody("Ship it", bad, now);
      expect(body).toContain("no recorded activity");
      expect(body).not.toMatch(/\d+\+? days?/);
    }
  });

  it("still says what happened and how to undo it", () => {
    const body = goalParkedBody("Ship it", new Date(now - 30 * DAY), now);
    expect(body).toContain("parked");
    expect(body).toContain("Resume it from Goals");
  });
});

// tried_dead_ends was [] on every goal ledger on live: clearApprovalFromGoalState
// only ever runs when a card is closed, and nothing had expired since it
// shipped. The backfill replays the already-closed cards — which is only safe
// because writing the same note twice is a no-op.
describe("dead-end backfill (pure parts)", () => {
  it("only backfills approvals that are actually closed", () => {
    expect(backfillOutcomeFor("expired")).toBe("expired");
    expect(backfillOutcomeFor("denied")).toBe("denied");
    expect(backfillOutcomeFor("pending")).toBeNull();
    expect(backfillOutcomeFor("approved")).toBeNull();
    expect(backfillOutcomeFor("")).toBeNull();
  });

  it("writes the note once and then nothing, however often it is replayed", () => {
    const note = approvalDeadEndNote("ap_123", "VERCEL_TOKEN", "expired");
    const first = mergeDeadEnd([], note);
    expect(first).toEqual([note]);
    expect(mergeDeadEnd(first!, note)).toBeNull();
    expect(mergeDeadEnd(first!, approvalDeadEndNote("ap_123", "VERCEL_TOKEN", "expired"))).toBeNull();
  });

  it("keeps a different card's note", () => {
    const a = approvalDeadEndNote("ap_1", "VERCEL_TOKEN", "expired");
    const b = approvalDeadEndNote("ap_2", "TAVILY_API_KEY", "denied");
    expect(mergeDeadEnd([a], b)).toEqual([a, b]);
  });

  it("ignores a blank note and stays bounded", () => {
    expect(mergeDeadEnd([], "   ")).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => `dead end ${i}`);
    const merged = mergeDeadEnd(many, "the newest one", 30)!;
    expect(merged).toHaveLength(30);
    expect(merged[29]).toBe("the newest one");
    expect(merged[0]).toBe("dead end 1");
  });
});
