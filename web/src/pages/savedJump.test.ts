import { describe, it, expect } from "vitest";
import { savedJumpUrl, type SavedRow } from "../pages/Saved";

const base = {
  messageId: "m1",
  conversationId: "c1",
  parentId: null,
  conversationKind: "channel" as const,
  conversationName: "general",
  conversationOtherMemberId: null,
  memberId: "u1",
  bodyMd: "hi",
  attachmentsJson: [],
  msgTs: "2026-10-15T00:00:00Z",
  savedAt: "2026-10-15T00:00:00Z",
};

describe("savedJumpUrl", () => {
  it("links a channel message through the search-jump contract (?m=)", () => {
    expect(savedJumpUrl(base as SavedRow)).toBe("/c/c1?m=m1");
  });

  it("names the thread root for a thread reply so the jump opens the thread", () => {
    expect(savedJumpUrl({ ...base, parentId: "root9" } as SavedRow)).toBe("/c/c1?m=m1&thread=root9");
  });

  it("links a DM via the other member and pins the conversation with c=", () => {
    const r = savedJumpUrl({
      ...base,
      conversationKind: "dm",
      conversationOtherMemberId: "u2",
    } as SavedRow);
    expect(r).toBe("/d/u2?m=m1&c=c1");
  });

  it("returns null for a DM whose counterpart is unknown (no dead link)", () => {
    expect(savedJumpUrl({ ...base, conversationKind: "dm", conversationOtherMemberId: null } as SavedRow)).toBeNull();
  });
});
