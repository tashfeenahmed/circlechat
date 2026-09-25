// Where a search hit lives, as a URL the app router understands.
//
// The top search used to navigate to the conversation only — the message list
// pins to the newest message, so every hit landed at the BOTTOM of a possibly
// months-old channel and the user had to hunt for the match. The hit's own id
// now travels as a `?m=` query parameter (plus `thread=<rootId>` for thread
// replies, and `c=<conversationId>` for DMs, whose conversation id resolves
// asynchronously on the page); the channel/DM pages read them, scroll the list
// to that message, and clear the parameters once handled.

export interface SearchHitConversation {
  id: string;
  kind: "channel" | "dm";
  name: string | null;
  otherMemberId?: string;
}

export interface JumpParams {
  /** The matched message. */
  messageId: string;
  /** Thread root when the match is a thread reply. */
  threadId: string | null;
  /** Conversation the match lives in, when the route doesn't say (DMs). */
  convId: string | null;
}

const nonBlank = (v: string | null): string | null => (v && v.trim() ? v : null);

/** The search-jump target encoded in a URL query string, if any. */
export function parseJump(search: string | URLSearchParams): JumpParams | null {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const messageId = nonBlank(p.get("m"));
  if (!messageId) return null;
  return { messageId, threadId: nonBlank(p.get("thread")), convId: nonBlank(p.get("c")) };
}

/** The message-list scroll target encoded in a URL, if any. */
export function parseJumpParam(search: string): string | null {
  return parseJump(search)?.messageId ?? null;
}

/**
 * Conversation route for a hit. `selfMemberId` is only needed for DMs whose
 * peer is unknown (self-DM fallback); pass undefined to omit the fallback.
 * `messageId` (the hit itself) is appended as `?m=` so the destination page
 * can land on the matching message instead of the newest one; `parentId`
 * (a thread reply's root) as `thread=` so the page opens that thread.
 */
export function searchHitUrl(
  c: SearchHitConversation | null,
  selfMemberId?: string | null,
  messageId?: string,
  parentId?: string | null,
): string | null {
  if (!c) return null;
  let path: string | null = null;
  if (c.kind === "channel") path = `/c/${c.id}`;
  else if (c.kind === "dm" && c.otherMemberId) path = `/d/${c.otherMemberId}`;
  else if (c.kind === "dm" && selfMemberId) path = `/d/${selfMemberId}`;
  if (!path) return null;
  if (!messageId) return path;
  const qs = new URLSearchParams({ m: messageId });
  if (parentId) qs.set("thread", parentId);
  // The DM route is keyed by the peer, not the conversation; carry the id so
  // the page only consumes the jump once it has resolved THIS conversation.
  if (c.kind === "dm") qs.set("c", c.id);
  return `${path}?${qs}`;
}

// A search jump pages backwards through history looking for its target. Cap
// it so a target that is gone (deleted after the search ran, or simply not in
// this list) can't walk an entire multi-year channel into memory — or burn
// through the API's 300 req/min per-client rate limit. 40 pages of 50 is the
// newest 2 000 messages; older hits get a "couldn't find" notice.
export const MAX_JUMP_PAGES = 40;

export type JumpStep =
  | { kind: "found"; index: number }
  | { kind: "wait" }
  | { kind: "load" }
  // "gone": all history searched (deleted, or never in this list);
  // "too-old": gave up at MAX_JUMP_PAGES with older history still unloaded.
  | { kind: "miss"; reason: "gone" | "too-old" };

/**
 * One step of the jump state machine, pure so it can be tested: given what the
 * list holds now, find the target, wait (first page or a requested older page
 * still in flight), ask for one more older page, or give up.
 */
export function nextJumpStep(s: {
  ids: readonly string[];
  targetId: string;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  canLoadOlder: boolean;
  pagesRequested: number;
  // List length when the last older page was requested (null: none yet).
  askedAtLength: number | null;
}): JumpStep {
  if (s.ids.length === 0) return { kind: "wait" };
  const index = s.ids.indexOf(s.targetId);
  if (index >= 0) return { kind: "found", index };
  if (s.isLoadingOlder) return { kind: "wait" };
  if (s.hasOlder && s.canLoadOlder) {
    if (s.pagesRequested >= MAX_JUMP_PAGES) return { kind: "miss", reason: "too-old" };
    return s.askedAtLength === s.ids.length ? { kind: "wait" } : { kind: "load" };
  }
  return { kind: "miss", reason: "gone" };
}
