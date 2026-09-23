import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  holdUnread,
  releaseUnreadHold,
  isUnreadHeld,
  subscribeUnreadHolds,
  getUnreadHolds,
} from "./unreadHold";

describe("unread hold", () => {
  beforeEach(() => {
    for (const id of [...getUnreadHolds()]) releaseUnreadHold(id);
  });

  it("holds a conversation until released", () => {
    expect(isUnreadHeld("c1")).toBe(false);
    holdUnread("c1");
    expect(isUnreadHeld("c1")).toBe(true);
    expect(isUnreadHeld("c2")).toBe(false);
    releaseUnreadHold("c1");
    expect(isUnreadHeld("c1")).toBe(false);
  });

  it("gives a new snapshot identity on change and notifies subscribers once per change", () => {
    const fn = vi.fn();
    const off = subscribeUnreadHolds(fn);
    const before = getUnreadHolds();
    holdUnread("c1");
    holdUnread("c1"); // no-op
    expect(getUnreadHolds()).not.toBe(before);
    expect(fn).toHaveBeenCalledTimes(1);
    releaseUnreadHold("c1");
    releaseUnreadHold("c1"); // no-op
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    holdUnread("c2");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
