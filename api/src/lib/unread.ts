import { sql, type SQL } from "drizzle-orm";
import { messages } from "../db/schema.js";

// "Mark unread from here" (Slack parity).
//
// The sidebar badge counts messages with `messages.ts > last_read_at` (see the
// unread query in routes/conversations.ts), so the cursor has to land strictly
// BEFORE the anchor message or the message the user pointed at stays read.
//
// The anchor is computed in SQL from the stored timestamp, one MICROsecond
// earlier. Doing it in JS (`new Date(m.ts.getTime() - 1)`) truncates Postgres'
// microsecond timestamps to milliseconds first, so the cursor could land up to
// ~2ms early and sweep an older message back into the unread count — or, for
// a message whose ts has sub-ms digits, still land after an older sibling in
// the same millisecond. 1µs is Postgres' timestamp resolution, i.e. the
// tightest cursor that still counts the anchor itself.
export function unreadAnchorSql(messageId: string): SQL {
  return sql`(select ${messages.ts} - interval '1 microsecond' from ${messages} where ${messages.id} = ${messageId})`;
}

export type MarkUnreadRejection = { status: 400 | 403 | 404; error: string };

// Guard rules for POST /messages/:id/unread-from, kept pure so they are
// unit-testable without a database.
//  - missing / deleted message → 404 (never confirm a deleted message exists)
//  - caller not a member of the message's conversation → 403
//  - thread reply → 400: the read cursor is per CONVERSATION and the badge only
//    counts top-level messages, so moving it to a reply's timestamp would
//    mark unrelated channel messages unread (or nothing at all). Threads have
//    no read state of their own to rewind.
export function markUnreadRejection(
  msg: { deletedAt: Date | null; parentId: string | null } | undefined,
  isMember: boolean,
): MarkUnreadRejection | null {
  if (!msg || msg.deletedAt) return { status: 404, error: "not_found" };
  if (!isMember) return { status: 403, error: "not_a_member" };
  if (msg.parentId) return { status: 400, error: "thread_reply" };
  return null;
}
