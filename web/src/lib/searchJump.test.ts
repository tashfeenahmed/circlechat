import { describe, it, expect } from "vitest";
import { parseJumpParam, searchHitUrl } from "./searchJump";

describe("searchHitUrl", () => {
  const channel = { id: "c1", kind: "channel" as const, name: "general" };
  const dm = { id: "c2", kind: "dm" as const, name: null, otherMemberId: "m9" };
  const dmNoPeer = { id: "c3", kind: "dm" as const, name: null };

  it("routes a channel hit to the channel with the message id attached", () => {
    expect(searchHitUrl(channel, undefined, "msg42")).toBe("/c/c1?m=msg42");
  });

  it("routes a DM hit to the peer DM with the message id attached", () => {
    expect(searchHitUrl(dm, "me1", "msg7")).toBe("/d/m9?m=msg7");
  });

  it("keeps the self-DM fallback and encodes ids safely", () => {
    expect(searchHitUrl(dmNoPeer, "me1", "m/1")).toBe("/d/me1?m=m%2F1");
    expect(searchHitUrl(dmNoPeer, undefined, "x")).toBeNull();
  });

  it("omits the query when there is no message id (old callers)", () => {
    expect(searchHitUrl(channel)).toBe("/c/c1");
  });

  it("returns null for an unknown conversation", () => {
    expect(searchHitUrl(null, "me1", "x")).toBeNull();
  });
});

describe("parseJumpParam", () => {
  it("reads the m parameter", () => {
    expect(parseJumpParam("?m=abc")).toBe("abc");
    expect(parseJumpParam("?x=1&m=abc")).toBe("abc");
  });

  it("treats blank/missing as no target", () => {
    expect(parseJumpParam("")).toBeNull();
    expect(parseJumpParam("?m=")).toBeNull();
    expect(parseJumpParam("?m=%20")).toBeNull();
  });
});
