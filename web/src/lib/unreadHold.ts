// "Mark unread from here" hold.
//
// Channel/DM auto-mark the open conversation read whenever its message count
// changes (POST /conversations/:id/read). Without a hold, the next incoming
// message — or any tab of yours sitting on that channel — would silently undo
// a "mark unread" the user just made. So a mark-unread (local, or synced from
// another of the user's sessions) HOLDS the conversation: auto-mark-read is
// suppressed while you stay on it, and the hold is released when you next
// ENTER the conversation (the deliberate "I'm reading it now" moment — Slack
// keeps it unread until you leave and come back), or when another session of
// yours marks it read.
//
// Deliberately in-memory: the persisted truth is the server-side cursor; the
// hold only governs this tab's auto-read behaviour.

type Listener = () => void;

let held: ReadonlySet<string> = new Set();
const listeners = new Set<Listener>();

function set(next: ReadonlySet<string>): void {
  held = next;
  for (const l of listeners) l();
}

export function holdUnread(conversationId: string): void {
  if (held.has(conversationId)) return;
  set(new Set([...held, conversationId]));
}

export function releaseUnreadHold(conversationId: string): void {
  if (!held.has(conversationId)) return;
  const next = new Set(held);
  next.delete(conversationId);
  set(next);
}

export function isUnreadHeld(conversationId: string): boolean {
  return held.has(conversationId);
}

// useSyncExternalStore plumbing (the Sidebar keeps showing the badge for the
// open conversation while it's held, so the click has visible feedback).
export function subscribeUnreadHolds(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getUnreadHolds(): ReadonlySet<string> {
  return held;
}
