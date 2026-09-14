import { describe, it, expect } from "vitest";
import { DEFAULT_NOTIFY_DEDUPE_MS, hasIdenticalUnread } from "../lib/notifications.js";

// The live inbox held 43,423 notifications, 41,001 of them the SAME unread
// "A goal looks stalled — needs your input" re-fired every ~21 minutes for nine
// dead goals. The stall pass resets lastProgressAt when it notifies, which
// re-arms the 15-minute stall window, which notifies again, forever.

const stall = (goalTitle: string) => ({
  kind: "system",
  title: "A goal looks stalled — needs your input",
  body: `${goalTitle} has shown no task progress for a while. Re-scope it or unblock the team.`,
  link: "/goals",
});

describe("hasIdenticalUnread", () => {
  it("an empty inbox never suppresses", () => {
    expect(hasIdenticalUnread([], stall("Ship the landing page"))).toBe(false);
  });

  it("suppresses a byte-for-byte repeat of an unread alert", () => {
    expect(hasIdenticalUnread([stall("Ship the landing page")], stall("Ship the landing page"))).toBe(true);
  });

  it("does not suppress the same alert about a DIFFERENT goal", () => {
    expect(hasIdenticalUnread([stall("Ship the landing page")], stall("Rewrite the docs"))).toBe(false);
  });

  it("does not suppress a different kind of alert with the same title", () => {
    const other = { ...stall("Ship the landing page"), kind: "approval" };
    expect(hasIdenticalUnread([stall("Ship the landing page")], other)).toBe(false);
  });

  it("does not suppress when only the deep link differs", () => {
    const other = { ...stall("Ship the landing page"), link: "/goals?id=g_2" };
    expect(hasIdenticalUnread([stall("Ship the landing page")], other)).toBe(false);
  });

  it("finds the match anywhere in the inbox page, not just at the head", () => {
    const inbox = [stall("A"), stall("B"), stall("C")];
    expect(hasIdenticalUnread(inbox, stall("C"))).toBe(true);
  });
});

describe("DEFAULT_NOTIFY_DEDUPE_MS", () => {
  it("is one day — the documented 'at most one stall alert per goal per 24h'", () => {
    expect(DEFAULT_NOTIFY_DEDUPE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
