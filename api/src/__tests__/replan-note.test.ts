import { describe, it, expect } from "vitest";
import { buildReplanNote } from "../lib/planner.js";

describe("buildReplanNote (facts-survey re-planning)", () => {
  it("separates verified facts from dead-ends and unverified assumptions", () => {
    const note = buildReplanNote(["site is at /workspace/neu-site"], ["Netlify Drop needs a browser"], 0, 2);
    expect(note).toContain("VERIFIED");
    expect(note).toContain("site is at /workspace/neu-site");
    expect(note).toContain("DEAD-ENDS");
    expect(note).toContain("Netlify Drop needs a browser");
    expect(note).toContain("UNVERIFIED");
    // The load-bearing instruction against the assume-success failure class:
    expect(note.toLowerCase()).toContain("do not assume");
  });

  it("handles an empty ledger gracefully", () => {
    const note = buildReplanNote([], [], 0, 2);
    expect(note).toContain("none recorded yet");
    expect(note).toContain("none recorded");
  });

  it("states the attempt number out of the max (budget pressure)", () => {
    expect(buildReplanNote([], [], 0, 2)).toContain("attempt 1 of 2");
    expect(buildReplanNote([], [], 1, 2)).toContain("attempt 2 of 2");
  });

  it("pushes for evidence-producing tasks over assumed ones", () => {
    expect(buildReplanNote([], [], 0, 2).toLowerCase()).toContain("evidence");
  });
});
