// "Mark unread from here" (Slack parity). The unread badge counts messages
// with `messages.ts > conversationMembers.lastReadAt` (see
// routes/conversations.ts), so anchoring the cursor AT the message timestamp
// would leave the anchor message itself read — the user clicks "unread from
// here" and the very message they pointed at stays gone from the count.
// The anchor must therefore sit strictly BEFORE the message, and a single
// millisecond is the smallest honest step: nothing between the previous
// message and the anchor can exist in a Postgres microsecond timeline that
// we would wrongly sweep in, and no real message lands inside 1ms of the
// anchor.
export function unreadAnchorTs(messageTs: Date): Date {
  return new Date(messageTs.getTime() - 1);
}
