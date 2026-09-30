/**
 * "N new messages" tail counter — the pure half of the jump-to-latest pill.
 *
 * MessageList only auto-scrolls when the viewport was already near the
 * bottom (Slack-style). Before this, a user scrolled up in history got zero
 * signal that the conversation moved on: Slack, Discord and Teams all show a
 * floating "N new messages ↓" pill that appears while you are off the tail
 * and counts arrivals from OTHER members (your own sends never count — you
 * just wrote them, and the auto-scroll already follows you when you're at
 * the bottom). Keeping the counter a pure reducer makes the counting rules
 * unit-testable without a DOM (lib/followTail.test.ts).
 */

export interface TailMessageEvent {
  type: "message";
  /** Was the viewport near the bottom at the moment the message arrived? */
  atBottom: boolean;
  /** Is the arriving message mine? */
  mine: boolean;
}

export interface TailScrollEvent {
  type: "scroll";
  /** Is the viewport near the bottom after this scroll? */
  atBottom: boolean;
}

export type TailEvent = TailMessageEvent | TailScrollEvent;

/**
 * Next unread-while-away count. Rules:
 *  - reaching the bottom (by any scroll) clears the count;
 *  - someone else's message while off the bottom increments it;
 *  - my own messages never increment it (I have seen what I just typed),
 *    but they also do not clear a count that earlier arrivals earned;
 *  - messages while already at the bottom do not count: auto-scroll follows
 *    and the resulting scroll event clears the state anyway.
 */
export function nextTailCount(prev: number, ev: TailEvent): number {
  if (ev.type === "scroll") return ev.atBottom ? 0 : prev;
  if (ev.atBottom || ev.mine) return prev;
  return prev + 1;
}

/** Pill label: singular/plural, and a count cap so the pill cannot stretch. */
export function tailLabel(count: number): string {
  const shown = count > 99 ? "99+" : String(count);
  return count === 1 ? `${shown} new message` : `${shown} new messages`;
}
