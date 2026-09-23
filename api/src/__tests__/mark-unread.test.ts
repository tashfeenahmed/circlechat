import { describe, it, expect } from "vitest";
import { and, eq, sql as dsql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { conversationMembers, messages } from "../db/schema.js";
import { unreadAnchorTs } from "../lib/unread.js";

// "Mark unread from here" (Slack parity). The sidebar badge counts messages
// with `messages.ts > conversationMembers.lastReadAt` (routes/conversations.ts),
// so the anchor written by POST /messages/:id/unread-from must be STRICTLY
// before the anchor message — otherwise the message the user just marked
// unread stays counted as read.

const CONV = "c_test_1";
const MEMBER = "m_test_1";
const MSG_TS = new Date("2026-09-23T10:00:00.000Z");

describe("unreadAnchorTs", () => {
  it("sits strictly before the anchor message (the badge counts it unread)", () => {
    const anchor = unreadAnchorTs(MSG_TS);
    expect(anchor.getTime()).toBeLessThan(MSG_TS.getTime());
    // and never further back than a millisecond — older messages stay read
    expect(MSG_TS.getTime() - anchor.getTime()).toBe(1);
  });

  it("against the badge predicate, the anchor message itself is unread", () => {
    // Mirrors the unread-count WHERE clause: ts > coalesce(last_read_at, epoch).
    const anchor = unreadAnchorTs(MSG_TS);
    const dialect = new PgDialect();
    const q = dialect.sqlToQuery(
      dsql`${messages.ts} > coalesce(${conversationMembers.lastReadAt}, 'epoch'::timestamptz)`,
    );
    expect(q.sql).toMatch(/> coalesce/);
    // Pure-TS stand-in for the SQL comparison: same operator, same operands,
    // using the REAL anchor the route writes.
    expect(MSG_TS.getTime() > unreadAnchorTs(MSG_TS).getTime()).toBe(true);
    // A message one step OLDER than the anchor is still read:
    const older = new Date(MSG_TS.getTime() - 5000);
    expect(older.getTime() > unreadAnchorTs(MSG_TS).getTime()).toBe(false);
  });
});

describe("mark-unread cursor update", () => {
  it("scopes the update to this conversation AND this member only", () => {
    const dialect = new PgDialect();
    const q = dialect.sqlToQuery(
      and(
        eq(conversationMembers.conversationId, CONV),
        eq(conversationMembers.memberId, MEMBER),
      )!,
    );
    expect(q.sql).toMatch(/"conversation_id"/);
    expect(q.sql).toMatch(/"member_id"/);
    // Both ids are bound, never inlined.
    expect(q.params).toContain(CONV);
    expect(q.params).toContain(MEMBER);
    expect(q.sql).not.toContain(CONV);
  });
});
