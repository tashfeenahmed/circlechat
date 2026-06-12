import { describe, it, expect } from "vitest";
import { needsProductivityReview } from "../lib/productivity.js";

describe("needsProductivityReview", () => {
  it("flags many real runs with zero applied actions", () => {
    expect(needsProductivityReview({ runs: 12, applied: 0 }, 12)).toBe(true);
    expect(needsProductivityReview({ runs: 50, applied: 0 }, 12)).toBe(true);
  });

  it("does not flag below the run threshold", () => {
    expect(needsProductivityReview({ runs: 11, applied: 0 }, 12)).toBe(false);
    expect(needsProductivityReview({ runs: 0, applied: 0 }, 12)).toBe(false);
  });

  it("a single applied action clears the flag — output happened", () => {
    expect(needsProductivityReview({ runs: 100, applied: 1 }, 12)).toBe(false);
  });
});
