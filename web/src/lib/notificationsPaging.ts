// Pure paging helpers for the notifications drawer.
//
// The API pages with an ISO `before` cursor (GET /notifications?before=...)
// and the drawer loads its first 30 rows in useNotifications. These helpers
// merge an older page into the cached first page without duplicates — the
// cursor is exclusive on `createdAt`, and rows can also arrive live via
// notification.new between paging requests, so ids must be deduped, not
// just concatenated.

import type { Notification } from "../api/client";

export interface NotificationsPage {
  notifications: Notification[];
  hasMore: boolean;
  nextBefore: string | null;
}

/** True when an older page could exist beyond what's loaded. */
export function canLoadOlder(page: NotificationsPage | undefined): boolean {
  return Boolean(page?.hasMore && page.nextBefore);
}

/**
 * Merge an older page under the current one. Newest-first order is kept,
 * rows already present (live prepends) are never duplicated, and a repeated
 * fetch of the same page is a no-op — which lets the caller retry freely.
 */
export function mergeOlderPage(
  current: NotificationsPage | undefined,
  older: NotificationsPage,
): NotificationsPage {
  if (!current) return older;
  const seen = new Set(current.notifications.map((n) => n.id));
  const appended = older.notifications.filter((n) => !seen.has(n.id));
  return {
    notifications: [...current.notifications, ...appended],
    hasMore: older.hasMore,
    nextBefore: older.nextBefore,
  };
}

/** Cursor for the next `before=` fetch, or null when there is nothing older. */
export function olderCursor(page: NotificationsPage | undefined): string | null {
  return canLoadOlder(page) ? (page as NotificationsPage).nextBefore : null;
}

export type { Notification };
