import { describe, it, expect } from "vitest";
import { summariseVerdict } from "../lib/tasks-core.js";

// The rule that decides what a human sees on a task card. The important case
// is `error`: the judge FAILS OPEN, so an outage writes an `error` row and the
// done-flip is allowed. Rendering that as a red "Verification failed" badge
// would tell a reviewer their deliverable was rejected when it was never
// judged at all.
describe("summariseVerdict", () => {
  const at = new Date("2026-08-25T10:00:00.000Z");

  it("returns null when the task was never judged", () => {
    expect(summariseVerdict(null)).toBeNull();
    expect(summariseVerdict(undefined)).toBeNull();
  });

  it("drops fail-open error verdicts rather than showing them as failures", () => {
    expect(
      summariseVerdict({ verdict: "error", score: null, rationale: "gateway timeout", createdAt: at }),
    ).toBeNull();
  });

  it("carries a passing verdict with its score", () => {
    expect(summariseVerdict({ verdict: "pass", score: 0.82, rationale: "meets criteria", createdAt: at })).toEqual({
      verdict: "pass",
      score: 0.82,
      rationale: "meets criteria",
      createdAt: at,
    });
  });

  it("carries a failing verdict with its rationale", () => {
    const v = summariseVerdict({ verdict: "fail", score: 0.3, rationale: "no deliverable", createdAt: at });
    expect(v?.verdict).toBe("fail");
    expect(v?.rationale).toBe("no deliverable");
  });

  it("keeps a null score null instead of coercing it to 0", () => {
    // `real` is null for non-rubric methods (the deterministic render gate).
    // Number(null) is 0, which would render as a bogus "Verified · 0.00".
    expect(summariseVerdict({ verdict: "pass", score: null, rationale: "", createdAt: at })?.score).toBeNull();
  });

  it("normalises a null rationale to an empty string", () => {
    expect(
      summariseVerdict({ verdict: "pass", score: 1, rationale: null as unknown as string, createdAt: at })?.rationale,
    ).toBe("");
  });
});
