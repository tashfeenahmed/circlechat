import { describe, expect, it } from "vitest";
import { messagePermalink } from "./permalink";

describe("messagePermalink", () => {
  it("builds a channel jump link", () => {
    expect(
      messagePermalink("m_1", { pathname: "/c/c_general", origin: "https://chat.test" }),
    ).toBe("https://chat.test/c/c_general?m=m_1");
  });

  it("adds thread= for a reply so the link opens the thread pane", () => {
    expect(
      messagePermalink("m_reply", {
        pathname: "/c/c_general",
        parentId: "m_root",
        origin: "https://chat.test",
      }),
    ).toBe("https://chat.test/c/c_general?m=m_reply&thread=m_root");
  });

  it("carries c= on DM routes (peer-keyed route, like the search jump does)", () => {
    expect(
      messagePermalink("m_2", {
        pathname: "/d/m_alice",
        conversationId: "c_dm_abc",
        origin: "https://chat.test",
      }),
    ).toBe("https://chat.test/d/m_alice?m=m_2&c=c_dm_abc");
  });

  it("omits c= on channel routes (the route already names the conversation)", () => {
    const url = messagePermalink("m_2", {
      pathname: "/c/c_general",
      conversationId: "c_general",
      origin: "https://chat.test",
    });
    expect(url).toBe("https://chat.test/c/c_general?m=m_2");
  });

  it("never carries over a stale query from the current URL", () => {
    // A link copied while a search jump left ?m=… on the bar must not share
    // the OLD jump key alongside the new one.
    const url = messagePermalink("m_new", {
      pathname: "/c/c_general?m=m_old&thread=m_rootx",
      origin: "https://chat.test",
    });
    expect(url).toBe("https://chat.test/c/c_general?m=m_new");
  });

  it("works without an origin (route-relative)", () => {
    expect(messagePermalink("m_1", { pathname: "/c/c_1" })).toBe("/c/c_1?m=m_1");
  });

  it("URL-encodes ids", () => {
    const url = messagePermalink("m&x", { pathname: "/c/c_1", origin: "http://h" });
    expect(url).toBe("http://h/c/c_1?m=m%26x");
  });
});
