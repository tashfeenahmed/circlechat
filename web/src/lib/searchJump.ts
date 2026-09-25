// Where a search hit lives, as a URL the app router understands.
//
// The top search used to navigate to the conversation only — the message list
// pins to the newest message, so every hit landed at the BOTTOM of a possibly
// months-old channel and the user had to hunt for the match. The hit's own id
// now travels as a `?m=` query parameter; the channel/DM pages read it, scroll
// the list to that message, and clear the parameter once handled.

export interface SearchHitConversation {
  id: string;
  kind: "channel" | "dm";
  name: string | null;
  otherMemberId?: string;
}

/** The message-list scroll target encoded in a URL, if any. */
export function parseJumpParam(search: string): string | null {
  const m = new URLSearchParams(search).get("m");
  return m && m.trim() ? m : null;
}

/**
 * Conversation route for a hit. `selfMemberId` is only needed for DMs whose
 * peer is unknown (self-DM fallback); pass undefined to omit the fallback.
 * `messageId` (the hit itself) is appended as `?m=` so the destination page
 * can land on the matching message instead of the newest one.
 */
export function searchHitUrl(
  c: SearchHitConversation | null,
  selfMemberId?: string | null,
  messageId?: string,
): string | null {
  if (!c) return null;
  let path: string | null = null;
  if (c.kind === "channel") path = `/c/${c.id}`;
  else if (c.kind === "dm" && c.otherMemberId) path = `/d/${c.otherMemberId}`;
  else if (c.kind === "dm" && selfMemberId) path = `/d/${selfMemberId}`;
  if (!path) return null;
  return messageId ? `${path}?m=${encodeURIComponent(messageId)}` : path;
}
