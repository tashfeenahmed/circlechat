import { describe, it, expect, afterEach } from "vitest";
import {
  approvalDeadEndNote,
  approvalExpiresAt,
  approvalTtlMs,
  isApprovalExpired,
  shouldLogSweepHeartbeat,
  SWEEP_HEARTBEAT_MS,
  expiryNote,
} from "../lib/approval-policy.js";
import { clampMeta } from "../lib/audit.js";

// APPROVAL_TTL_HOURS=72 was set on live and expireStaleApprovals() was wired
// into the worker sweep, yet all five pending cards carried the SAME decided_at
// (the 5 Sep deploy) and 72h of worker logs contained no approval line at all —
// there was no way to tell a silent healthy sweep from one that had stopped.

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("shouldLogSweepHeartbeat", () => {
  it("logs the first time the sweep ever runs", () => {
    expect(shouldLogSweepHeartbeat(Date.now(), 0)).toBe(true);
  });

  it("stays quiet between heartbeats — the sweep ticks every 3 minutes", () => {
    const now = 10_000_000;
    expect(shouldLogSweepHeartbeat(now + 3 * 60_000, now)).toBe(false);
    expect(shouldLogSweepHeartbeat(now + 29 * 60_000, now)).toBe(false);
  });

  it("logs again once the heartbeat window has passed", () => {
    const now = 10_000_000;
    expect(shouldLogSweepHeartbeat(now + SWEEP_HEARTBEAT_MS + 1, now)).toBe(true);
  });
});

describe("approvalDeadEndNote", () => {
  it("names the card and tells the team it is not a live blocker", () => {
    const note = approvalDeadEndNote("ap_1xe7eca8xa4xyqrwbeuq", "vercel_token", "expired");
    expect(note).toContain("ap_1xe7eca8xa4xyqrwbeuq");
    expect(note).toContain("expired");
    expect(note).toContain("NOT a live blocker");
  });

  it("is deterministic so the ledger keeps exactly one copy", () => {
    // appendDeadEnd dedupes on exact string equality; drifting text would let
    // the same dead card accumulate a new ledger line on every sweep.
    const a = approvalDeadEndNote("ap_x", "deploy", "expired");
    const b = approvalDeadEndNote("ap_x", "deploy", "expired");
    expect(a).toBe(b);
  });

  it("distinguishes a denial from an expiry", () => {
    expect(approvalDeadEndNote("ap_x", "deploy", "denied")).toContain("denied");
    expect(approvalDeadEndNote("ap_x", "deploy", "denied")).not.toBe(
      approvalDeadEndNote("ap_x", "deploy", "expired"),
    );
  });

  it("survives an empty scope", () => {
    expect(approvalDeadEndNote("ap_x", "", "expired")).toContain("unscoped");
  });
});

describe("TTL arithmetic", () => {
  it("expires a card exactly TTL hours after it was created", () => {
    process.env.APPROVAL_TTL_HOURS = "72";
    const created = new Date("2026-09-01T00:00:00Z");
    expect(approvalTtlMs()).toBe(72 * 3_600_000);
    expect(approvalExpiresAt(created)!.toISOString()).toBe("2026-09-04T00:00:00.000Z");
    expect(isApprovalExpired(created, new Date("2026-09-03T23:59:00Z"))).toBe(false);
    expect(isApprovalExpired(created, new Date("2026-09-04T00:00:01Z"))).toBe(true);
  });

  it("treats TTL 0 as never-expire, and the sweep as disabled", () => {
    process.env.APPROVAL_TTL_HOURS = "0";
    expect(approvalTtlMs()).toBe(0);
    expect(approvalExpiresAt(new Date())).toBeNull();
    expect(isApprovalExpired(new Date("2020-01-01T00:00:00Z"))).toBe(false);
  });

  it("tells the agent not to re-ask when a card expires", () => {
    process.env.APPROVAL_TTL_HOURS = "72";
    const note = expiryNote();
    expect(note).toContain("EXPIRED");
    expect(note).toContain("do NOT re-request");
  });
});

// audit_events had zero rows on live; these are the guardrails that keep the
// new writers cheap and safe now that every lifecycle event writes one.
describe("audit meta clamping", () => {
  it("drops secret-shaped keys outright", () => {
    const meta = clampMeta({ scope: "deploy", apiKey: "sk-live-xxx", token: "t", password: "p" });
    expect(meta).toEqual({ scope: "deploy" });
  });

  it("truncates long strings so one rationale can't bloat the table", () => {
    const meta = clampMeta({ rationale: "x".repeat(5000) });
    expect(String(meta.rationale).length).toBeLessThan(700);
    expect(String(meta.rationale).endsWith("…")).toBe(true);
  });

  it("keeps scalars, caps arrays, and stringifies objects", () => {
    const meta = clampMeta({
      n: 7,
      ok: false,
      nothing: null,
      many: Array.from({ length: 50 }, (_, i) => `item-${i}`),
      nested: { a: 1 },
    });
    expect(meta.n).toBe(7);
    expect(meta.ok).toBe(false);
    expect(meta.nothing).toBeNull();
    expect((meta.many as string[]).length).toBe(20);
    expect(meta.nested).toBe('{"a":1}');
  });

  it("skips undefined values rather than writing nulls", () => {
    expect(clampMeta({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });
});
