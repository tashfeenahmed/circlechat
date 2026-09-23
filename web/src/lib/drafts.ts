// Per-conversation composer drafts.
//
// Before this, Composer kept its text in plain useState: switching channels,
// closing a thread, or a page refresh silently destroyed an in-progress
// message. Slack, Discord and Loomio all persist a draft per channel; this is
// the same pattern, keyed by conversationId (thread composers pass
// `thread:<rootId>` so a thread draft can't collide with the channel draft).
//
// Storage failures (private mode, quota) degrade to no-persistence rather
// than throwing — typing must never break because localStorage did.

const DRAFT_PREFIX = "cc:draft:";
const MAX_DRAFT_CHARS = 100_000;

export interface StoredDraft {
  body: string;
}

export function draftKey(scope: string): string {
  return `${DRAFT_PREFIX}${scope}`;
}

export function loadDraft(scope: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (typeof parsed?.body !== "string") return null;
    return parsed.body ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(scope: string, body: string): void {
  try {
    if (!body) {
      localStorage.removeItem(draftKey(scope));
      return;
    }
    // Guard against pathological pastes blowing the storage quota for
    // everything else under cc:*; beyond the cap we simply stop persisting.
    if (body.length > MAX_DRAFT_CHARS) return;
    localStorage.setItem(draftKey(scope), JSON.stringify({ body }));
  } catch {
    // ignore — drafts are best-effort
  }
}

export function clearDraft(scope: string): void {
  try {
    localStorage.removeItem(draftKey(scope));
  } catch {
    // ignore
  }
}
