// Guards for mutating an existing message, kept pure so they are unit-testable
// without a database (same pattern as lib/unread.ts / lib/leave-channel.ts).
//
// A soft-deleted message is gone for every reader: the list filters it in SQL,
// search skips it, `redactDeleted` blanks its body as a backstop, and the
// pin and mark-unread routes both answer 404 for it. Edit and react used to
// disagree: PATCH /messages/:id on a deleted row answered 200 and wrote a live
// `bodyMd` + `editedAt` onto the tombstone — invisible in the UI (it stays
// filtered out), which made it look like a no-op to the user while the stored
// row quietly carried text again. Any future path that revives or exports
// rows would resurrect content its author had deleted. Reacting had the dual
// oddity of accepting a reaction to a message that no longer renders, and
// broadcasting `reaction.toggled` into the conversation for it.
//
// Rule, matching pin/unread-from: a missing OR deleted message is 404 —
// never confirm a deleted message exists, never mutate one.

export type MutationRejection = { status: 403 | 404; error: string };

/**
 * Edit guard: 404 when the message is missing or deleted, 403 when the caller
 * isn't the author, null to proceed.
 */
export function editRejection(
  msg: { memberId: string; deletedAt: Date | null } | undefined,
  callerMemberId: string,
): MutationRejection | null {
  if (!msg || msg.deletedAt) return { status: 404, error: "not_found" };
  if (msg.memberId !== callerMemberId) return { status: 403, error: "not_author" };
  return null;
}

/**
 * React guard: 404 when the message is missing or deleted (membership is
 * checked separately by the route, which needs a conversation lookup anyway).
 */
export function reactRejection(
  msg: { deletedAt: Date | null } | undefined,
): MutationRejection | null {
  if (!msg || msg.deletedAt) return { status: 404, error: "not_found" };
  return null;
}
