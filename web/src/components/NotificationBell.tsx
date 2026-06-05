import { useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  AtSign,
  MessageSquare,
  CheckSquare,
  ShieldQuestion,
  Info,
  CheckCheck,
  X,
} from "lucide-react";
import {
  useNotifications,
  useMarkNotificationsRead,
  useMarkAllNotificationsRead,
  useMarkConversationNotificationsRead,
} from "../lib/hooks";
import type { Notification, NotificationKind } from "../api/client";

function iconFor(kind: NotificationKind) {
  switch (kind) {
    case "mention":
      return <AtSign size={13} strokeWidth={2} />;
    case "dm":
      return <MessageSquare size={13} strokeWidth={2} />;
    case "task_assigned":
    case "task_comment":
      return <CheckSquare size={13} strokeWidth={2} />;
    case "approval":
      return <ShieldQuestion size={13} strokeWidth={2} />;
    default:
      return <Info size={13} strokeWidth={2} />;
  }
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// A bundle groups every notification that points at the same conversation (or
// the same task) into a single row, so two quick pings from one agent show as
// one entry — "Samantha · 2 new" — instead of spamming the list. Standalone
// kinds (system/approval, no conversation or task) bundle by their own id.
interface Bundle {
  key: string;
  latest: Notification;
  items: Notification[];
  total: number;
  unread: number;
}

function bundleKey(n: Notification): string {
  if (n.conversationId) return `c:${n.conversationId}`;
  if (n.taskId) return `t:${n.taskId}`;
  return `n:${n.id}`;
}

export default function NotificationBell() {
  // Mount the list hook here so its WS listener (notification.new/read) stays
  // active for as long as the bell is on screen — i.e. the whole app shell.
  // The unread badge derives from this list, so it stays live while closed.
  const list = useNotifications();
  const markMany = useMarkNotificationsRead();
  const markAll = useMarkAllNotificationsRead();
  const markConv = useMarkConversationNotificationsRead();
  const nav = useNavigate();

  // Base UI Dialog keeps the popup mounted through its exit transition
  // ([data-ending-style]) and unmounts after, so the old open/render/shown
  // three-state dance is gone — one piece of state, CSS does the slide.
  const [open, setOpen] = useState(false);

  const items = useMemo(
    () => list.data?.notifications ?? [],
    [list.data?.notifications],
  );

  // Group newest-first list into bundles, preserving recency order.
  const bundles = useMemo<Bundle[]>(() => {
    const map = new Map<string, Bundle>();
    for (const n of items) {
      const key = bundleKey(n);
      const b = map.get(key);
      if (b) {
        b.items.push(n);
        b.total += 1;
        if (!n.readAt) b.unread += 1;
      } else {
        map.set(key, {
          key,
          latest: n,
          items: [n],
          total: 1,
          unread: n.readAt ? 0 : 1,
        });
      }
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        new Date(b.latest.createdAt).getTime() -
        new Date(a.latest.createdAt).getTime(),
    );
  }, [items]);

  // Badge counts unread *bundles* (threads), not raw rows — so repeated pings
  // from the same conversation read as one. This is the number the user sees.
  const count = bundles.reduce((acc, b) => acc + (b.unread > 0 ? 1 : 0), 0);

  function onClickBundle(b: Bundle) {
    // Mark the whole bundle read in one optimistic step so it clears the instant
    // it's clicked. Conversation bundles use the per-conversation endpoint (also
    // catches unread rows beyond the loaded page); task/standalone bundles mark
    // their unread ids together (one invalidate, no per-row refetch race).
    if (b.unread > 0) {
      const convId = b.latest.conversationId;
      if (convId) {
        markConv.mutate(convId);
      } else {
        markMany.mutate(b.items.filter((n) => !n.readAt).map((n) => n.id));
      }
    }
    setOpen(false);
    if (b.latest.link) nav(b.latest.link);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className="tb-btn inline-flex items-center relative"
        title="Notifications"
      >
        <Bell size={15} strokeWidth={2} />
        {count > 0 && (
          <span className="notif-badge">{count > 99 ? "99+" : count}</span>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="cc-notif-backdrop" />
        <Dialog.Popup
          className="cc-notif-drawer"
          render={<aside aria-label="Notifications" />}
        >
            <div className="cc-notif-drawer-head">
              <span className="notif-title">Notifications</span>
              <div className="cc-notif-head-actions">
                {count > 0 && (
                  <button
                    type="button"
                    className="notif-readall"
                    onClick={() => markAll.mutate()}
                    title="Mark all as read"
                  >
                    <CheckCheck size={13} strokeWidth={2} /> Mark all read
                  </button>
                )}
                <button
                  type="button"
                  className="cc-notif-close"
                  onClick={() => setOpen(false)}
                  title="Close"
                  aria-label="Close notifications"
                >
                  <X size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="cc-notif-drawer-list">
              {bundles.length === 0 && (
                <div className="notif-empty">You're all caught up.</div>
              )}
              {bundles.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  className={`notif-item ${b.unread > 0 ? "unread" : ""}`}
                  onClick={() => onClickBundle(b)}
                >
                  <span className="notif-item-icon">
                    {iconFor(b.latest.kind)}
                  </span>
                  <span className="notif-item-body">
                    <span className="notif-item-title">
                      {b.latest.title}
                      {b.total > 1 && (
                        <span className="notif-count-pill">{b.total}</span>
                      )}
                    </span>
                    {b.latest.body && (
                      <span className="notif-item-text">{b.latest.body}</span>
                    )}
                  </span>
                  <span className="notif-item-time">
                    {timeAgo(b.latest.createdAt)}
                  </span>
                </button>
              ))}
            </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
