import { describe, it, expect } from "vitest";
import { MAX_JUMP_PAGES, nextJumpStep, parseJump, parseJumpParam, searchHitUrl } from "./searchJump";

describe("searchHitUrl", () => {
  const channel = { id: "c1", kind: "channel" as const, name: "general" };
  const dm = { id: "c2", kind: "dm" as const, name: null, otherMemberId: "m9" };
  const dmNoPeer = { id: "c3", kind: "dm" as const, name: null };

  it("routes a channel hit to the channel with the message id attached", () => {
    expect(searchHitUrl(channel, undefined, "msg42")).toBe("/c/c1?m=msg42");
  });

  it("routes a DM hit to the peer DM with the message and conversation ids", () => {
    expect(searchHitUrl(dm, "me1", "msg7")).toBe("/d/m9?m=msg7&c=c2");
  });

  it("keeps the self-DM fallback and encodes ids safely", () => {
    expect(searchHitUrl(dmNoPeer, "me1", "m/1")).toBe("/d/me1?m=m%2F1&c=c3");
    expect(searchHitUrl(dmNoPeer, undefined, "x")).toBeNull();
  });

  it("adds the thread root for thread replies", () => {
    expect(searchHitUrl(channel, undefined, "r1", "root1")).toBe("/c/c1?m=r1&thread=root1");
    expect(searchHitUrl(dm, "me1", "r1", "root1")).toBe("/d/m9?m=r1&thread=root1&c=c2");
  });

  it("omits the query when there is no message id (old callers)", () => {
    expect(searchHitUrl(channel)).toBe("/c/c1");
  });

  it("returns null for an unknown conversation", () => {
    expect(searchHitUrl(null, "me1", "x")).toBeNull();
  });
});

describe("parseJump", () => {
  it("reads the m parameter", () => {
    expect(parseJumpParam("?m=abc")).toBe("abc");
    expect(parseJumpParam("?x=1&m=abc")).toBe("abc");
  });

  it("treats blank/missing as no target", () => {
    expect(parseJumpParam("")).toBeNull();
    expect(parseJumpParam("?m=")).toBeNull();
    expect(parseJumpParam("?m=%20")).toBeNull();
    expect(parseJump("?thread=root1")).toBeNull();
  });

  it("round-trips what searchHitUrl produces", () => {
    const url = searchHitUrl({ id: "c2", kind: "dm", name: null, otherMemberId: "m9" }, "me", "r1", "root1")!;
    expect(parseJump(url.slice(url.indexOf("?")))).toEqual({ messageId: "r1", threadId: "root1", convId: "c2" });
    expect(parseJump("?m=x&thread=")).toEqual({ messageId: "x", threadId: null, convId: null });
  });
});

describe("nextJumpStep", () => {
  const base = {
    ids: ["a", "b", "c"],
    targetId: "x",
    hasOlder: true,
    isLoadingOlder: false,
    canLoadOlder: true,
    pagesRequested: 0,
    askedAtLength: null as number | null,
  };

  it("finds a loaded target", () => {
    expect(nextJumpStep({ ...base, targetId: "b" })).toEqual({ kind: "found", index: 1 });
  });

  it("waits for the first page instead of giving up on an empty list", () => {
    expect(nextJumpStep({ ...base, ids: [], hasOlder: false })).toEqual({ kind: "wait" });
  });

  it("pages older history while the target is missing", () => {
    expect(nextJumpStep(base)).toEqual({ kind: "load" });
  });

  it("never asks twice for the same page (in flight or not yet merged)", () => {
    expect(nextJumpStep({ ...base, isLoadingOlder: true })).toEqual({ kind: "wait" });
    expect(nextJumpStep({ ...base, pagesRequested: 1, askedAtLength: 3 })).toEqual({ kind: "wait" });
    expect(nextJumpStep({ ...base, pagesRequested: 1, askedAtLength: 2 })).toEqual({ kind: "load" });
  });

  it("gives up when history is exhausted (deleted / foreign target)", () => {
    expect(nextJumpStep({ ...base, hasOlder: false })).toEqual({ kind: "miss", reason: "gone" });
    expect(nextJumpStep({ ...base, canLoadOlder: false })).toEqual({ kind: "miss", reason: "gone" });
  });

  it("gives up after MAX_JUMP_PAGES pages instead of walking all history", () => {
    expect(nextJumpStep({ ...base, pagesRequested: MAX_JUMP_PAGES - 1, askedAtLength: 1 })).toEqual({ kind: "load" });
    expect(nextJumpStep({ ...base, pagesRequested: MAX_JUMP_PAGES, askedAtLength: 1 })).toEqual({ kind: "miss", reason: "too-old" });
  });
});
