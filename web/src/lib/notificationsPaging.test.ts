import { describe, it, expect } from "vitest";
import {
  canLoadOlder,
  mergeOlderPage,
  olderCursor,
  type NotificationsPage,
} from "./notificationsPaging";

function n(id: string): NotificationsPage["notifications"][number] {
  return {
    id,
    workspaceId: "w1",
    memberId: "m1",
    kind: "mention",
    actorMemberId: null,
    title: "t",
    body: "",
    link: "",
    conversationId: null,
    messageId: null,
    taskId: null,
    readAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  } as NotificationsPage["notifications"][number];
}

const page = (ids: string[], hasMore: boolean, nextBefore: string | null): NotificationsPage => ({
  notifications: ids.map(n),
  hasMore,
  nextBefore,
});

describe("notifications paging", () => {
  it("offers 'load older' only when the API says more exist", () => {
    expect(canLoadOlder(undefined)).toBe(false);
    expect(canLoadOlder(page(["a"], false, null))).toBe(false);
    expect(canLoadOlder(page(["a"], true, "2026-10-01T00:00:00.000Z"))).toBe(true);
    expect(olderCursor(page(["a"], true, "2026-10-01T00:00:00.000Z"))).toBe("2026-10-01T00:00:00.000Z");
    expect(olderCursor(page(["a"], true, null))).toBe(null);
  });

  it("appends an older page below the loaded rows", () => {
    const merged = mergeOlderPage(page(["new"], true, "t1"), page(["old1", "old2"], true, "t2"));
    expect(merged.notifications.map((x) => x.id)).toEqual(["new", "old1", "old2"]);
    expect(merged.nextBefore).toBe("t2");
  });

  it("never duplicates rows that arrived live between pages", () => {
    // A live notification.new prepend put "hot" in the cache while the
    // older-page fetch was in flight, and the server page repeats it.
    const merged = mergeOlderPage(page(["hot"], true, "t1"), page(["old1", "hot"], false, null));
    expect(merged.notifications.map((x) => x.id)).toEqual(["hot", "old1"]);
    expect(merged.hasMore).toBe(false);
  });

  it("merging the same page twice changes nothing (retry-safe)", () => {
    const first = mergeOlderPage(page(["a"], true, "t1"), page(["b"], true, "t2"));
    const second = mergeOlderPage(first, page(["b"], true, "t2"));
    expect(second.notifications.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("merging into an empty cache adopts the older page", () => {
    const merged = mergeOlderPage(undefined, page(["b"], false, null));
    expect(merged.notifications.map((x) => x.id)).toEqual(["b"]);
  });
});
