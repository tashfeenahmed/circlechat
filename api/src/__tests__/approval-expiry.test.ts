import { describe, it, expect, afterEach } from "vitest";
// Imports the LEAF module on purpose: lib/approval-policy.js pulls in the DB,
// the event bus and the BullMQ queues, which a unit test has no business
// starting. (TTL arithmetic itself is covered in approval-policy.test.ts.)
import {
  approvalDeadEndNote,
  shouldLogSweepHeartbeat,
  SWEEP_HEARTBEAT_MS,
} from "../lib/approval-notes.js";
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
