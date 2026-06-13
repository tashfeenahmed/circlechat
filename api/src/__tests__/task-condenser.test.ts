import { describe, it, expect } from "vitest";
import { shouldRefresh, KEEP_RECENT } from "../lib/task-condenser.js";

// shouldRefresh(total, summarized): summarize the comments that have aged past
// the live window (total - KEEP_RECENT), refreshing once 5 more have aged or
// when no summary exists yet.

describe("shouldRefresh", () => {
  it("never summarizes a thread within the live window", () => {
    expect(shouldRefresh(KEEP_RECENT, 0)).toBe(false);
    expect(shouldRefresh(KEEP_RECENT - 3, 0)).toBe(false);
  });

  it("summarizes once comments age past the window and none are summarized yet", () => {
    // total 16 → 6 aged out, 0 summarized → build it.
    expect(shouldRefresh(KEEP_RECENT + 6, 0)).toBe(true);
  });

  it("does not re-summarize for a small increment under the gap", () => {
    // 12 aged out, 10 already summarized → only 2 new, below the 5 gap.
    expect(shouldRefresh(KEEP_RECENT + 12, 10)).toBe(false);
  });

  it("re-summarizes once the gap of newly-aged comments is reached", () => {
    // 15 aged out, 10 summarized → 5 new aged → refresh.
    expect(shouldRefresh(KEEP_RECENT + 15, 10)).toBe(true);
  });

  it("a single aged comment with no summary still triggers the first build", () => {
    expect(shouldRefresh(KEEP_RECENT + 1, 0)).toBe(true);
  });
});
