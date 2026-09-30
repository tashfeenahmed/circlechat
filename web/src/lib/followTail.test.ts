import { describe, expect, it } from "vitest";

import { nextTailCount, tailLabel } from "./followTail";

// The counting rules for the "N new messages ↓" pill, kept pure so they are
// testable without a DOM. Before this feature the list silently moved on
// without you when you were scrolled up reading history.

describe("nextTailCount", () => {
  it("counts someone else's message while off the tail", () => {
    expect(nextTailCount(0, { type: "message", atBottom: false, mine: false })).toBe(1);
    expect(nextTailCount(4, { type: "message", atBottom: false, mine: false })).toBe(5);
  });

  it("never counts my own messages", () => {
    expect(nextTailCount(0, { type: "message", atBottom: false, mine: true })).toBe(0);
    // an earlier real count survives my own send
    expect(nextTailCount(2, { type: "message", atBottom: false, mine: true })).toBe(2);
  });

  it("does not count while at the tail (auto-scroll follows)", () => {
    expect(nextTailCount(0, { type: "message", atBottom: true, mine: false })).toBe(0);
    expect(nextTailCount(3, { type: "message", atBottom: true, mine: false })).toBe(3);
  });

  it("clears when scrolling reaches the tail", () => {
    expect(nextTailCount(7, { type: "scroll", atBottom: true })).toBe(0);
  });

  it("holds the count on scrolls away from the tail", () => {
    expect(nextTailCount(7, { type: "scroll", atBottom: false })).toBe(7);
  });
});

describe("tailLabel", () => {
  it("singularises one message", () => {
    expect(tailLabel(1)).toBe("1 new message");
  });

  it("pluralises", () => {
    expect(tailLabel(2)).toBe("2 new messages");
    expect(tailLabel(99)).toBe("99 new messages");
  });

  it("caps the count so the pill cannot stretch", () => {
    expect(tailLabel(100)).toBe("99+ new messages");
  });
});
