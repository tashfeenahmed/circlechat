// Per-message permalink — the URL half of "Copy link" on a message.
//
// The app already understands the destination format: `?m=<messageId>` makes
// a message list scroll to that message and flash it, and `thread=<rootId>`
// additionally opens the thread pane and jumps inside it (see lib/searchJump
// .ts and lib/useSearchJump.ts — that's how search results deep-link). What
// was missing is a way to PRODUCE such a URL: every competitor lets you share
// a link to a specific message (Slack "Copy link", Discord "Copy Link" on a
// thread, Teams "Copy link to message"), and without it the only way to point
// a teammate at a message is to describe it.
//
// The link hangs the jump keys off the CURRENT route, which is by definition
// a URL that resolves to this conversation (`/c/<convId>` or `/d/<peer>`).
// A reply carries its root as `thread=` (the server flattens every reply
// onto the root, so parentId IS the root id) so the link opens the thread.
// DM routes are keyed by peer, not conversation, so `c=<convId>` rides along
// exactly like the search-jump builder does — the DM page waits for the
// conversation to resolve before consuming the jump.

export const JUMP_PARAM = "m";
export const THREAD_PARAM = "thread";
export const CONV_PARAM = "c";

export interface PermalinkOptions {
  /** Current route path, e.g. "/c/c_123" or "/d/m_456" (no query string). */
  pathname: string;
  /** Conversation id — required on DM routes, harmless elsewhere. */
  conversationId?: string | null;
  /** Thread root when the message is a reply. */
  parentId?: string | null;
  /** Scheme+host to prepend (for tests / non-DOM callers); omitted by default. */
  origin?: string;
}

/** Absolute URL to `messageId`, consumable by lib/useSearchJump. */
export function messagePermalink(messageId: string, options: PermalinkOptions): string {
  const params = new URLSearchParams();
  params.set(JUMP_PARAM, messageId);
  if (options.parentId) params.set(THREAD_PARAM, options.parentId);
  if (options.conversationId && options.pathname.startsWith("/d/")) {
    params.set(CONV_PARAM, options.conversationId);
  }
  const path = options.pathname.split("?")[0];
  return `${options.origin ?? ""}${path}?${params.toString()}`;
}
