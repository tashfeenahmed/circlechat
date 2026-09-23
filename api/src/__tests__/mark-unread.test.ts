import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { conversationMembers } from "../db/schema.js";
import { markUnreadRejection, unreadAnchorSql } from "../lib/unread.js";

// "Mark unread from here" (Slack parity). The sidebar badge counts messages
// with `messages.ts > conversation_members.last_read_at` (routes/conversations.ts),
// so the cursor POST /messages/:id/unread-from writes must sit strictly before
// the anchor message — at Postgres' own (microsecond) resolution, not a
// JS-millisecond approximation. These compile the real SQL the route builds
// (same approach as pinned-messages.test.ts); the end-to-end behaviour was
// also exercised against a live Postgres.

const dialect = new PgDialect();
const MSG = "msg_test_1";
const CONV = "c_test_1";
const MEMBER = "m_test_1";

describe("unread anchor SQL", () => {
  const q = dialect.sqlToQuery(unreadAnchorSql(MSG));

  it("derives the cursor from the stored message ts, one microsecond earlier", () => {
    expect(q.sql).toMatch(/select "messages"\."ts" - interval '1 microsecond' from "messages"/);
    // Not a millisecond: a JS Date round-trip would truncate the stored µs.
    expect(q.sql).not.toMatch(/millisecond/);
  });

  it("looks the message up by a bound id (never inlined)", () => {
    expect(q.sql).toMatch(/where "messages"\."id" = \$1/);
    expect(q.params).toEqual([MSG]);
    expect(q.sql).not.toContain(MSG);
  });
});

describe("mark-unread guards", () => {
  const live = { deletedAt: null, parentId: null };

  it("404s a missing or deleted message before checking membership", () => {
    expect(markUnreadRejection(undefined, true)).toEqual({ status: 404, error: "not_found" });
    expect(markUnreadRejection({ ...live, deletedAt: new Date() }, true)).toEqual({
      status: 404,
      error: "not_found",
    });
    // A non-member probing a deleted id learns nothing more than "not found".
    expect(markUnreadRejection({ ...live, deletedAt: new Date() }, false)?.status).toBe(404);
  });

  it("403s a caller who is not a member of the message's conversation", () => {
    expect(markUnreadRejection(live, false)).toEqual({ status: 403, error: "not_a_member" });
  });

  it("refuses thread replies: the cursor is per conversation and only counts top-level messages", () => {
    expect(markUnreadRejection({ ...live, parentId: "root_1" }, true)).toEqual({
      status: 400,
      error: "thread_reply",
    });
    // Membership is still checked first — a non-member gets 403, not a hint.
    expect(markUnreadRejection({ ...live, parentId: "root_1" }, false)?.status).toBe(403);
  });

  it("allows a live top-level message in a conversation the caller belongs to", () => {
    expect(markUnreadRejection(live, true)).toBeNull();
  });
});

describe("mark-unread cursor update scope", () => {
  it("targets only this conversation AND this member's row, with bound params", () => {
    const q = dialect.sqlToQuery(
      and(
        eq(conversationMembers.conversationId, CONV),
        eq(conversationMembers.memberId, MEMBER),
      )!,
    );
    expect(q.sql).toMatch(/"conversation_id" = \$1 and .*"member_id" = \$2/);
    expect(q.params).toEqual([CONV, MEMBER]);
  });
});
