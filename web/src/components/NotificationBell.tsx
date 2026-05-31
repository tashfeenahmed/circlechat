import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bell, AtSign, MessageSquare, CheckSquare, ShieldQuestion, Info, CheckCheck } from "lucide-react";
import {
  useNotifications,
  useUnreadNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
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

export default function NotificationBell() {
  // Mount the list hook here so its WS listener (notification.new/read) stays
  // active for as long as the bell is on screen — i.e. the whole app shell.
  // That keeps the unread badge live even while the dropdown is closed.
  const list = useNotifications();
  const unread = useUnreadNotifications();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const nav = useNavigate();

  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const count = unread.data?.count ?? 0;
  const items = list.data?.notifications ?? [];

  function open() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 340;
    const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left });
  }
  function close() {
    setPos(null);
  }

  useEffect(() => {
    if (!pos) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onDoc(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (btnRef.current?.contains(target)) return;
      const menu = document.getElementById("__cc_notif_popover");
      if (menu && menu.contains(target)) return;
      close();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  function onClickItem(n: Notification) {
    if (!n.readAt) markRead.mutate(n.id);
    close();
    if (n.link) nav(n.link);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="tb-btn inline-flex items-center relative"
        title="Notifications"
        aria-haspopup="menu"
        aria-expanded={!!pos}
        onClick={() => (pos ? close() : open())}
      >
        <Bell size={15} strokeWidth={2} />
        {count > 0 && <span className="notif-badge">{count > 99 ? "99+" : count}</span>}
      </button>
      {pos &&
        createPortal(
          <div
            id="__cc_notif_popover"
            role="menu"
            className="notif-popover"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            <div className="notif-head">
              <span className="notif-title">Notifications</span>
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
            </div>
            <div className="notif-list">
              {items.length === 0 && (
                <div className="notif-empty">You're all caught up.</div>
              )}
              {items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={`notif-item ${n.readAt ? "" : "unread"}`}
                  onClick={() => onClickItem(n)}
                >
                  <span className="notif-item-icon">{iconFor(n.kind)}</span>
                  <span className="notif-item-body">
                    <span className="notif-item-title">{n.title}</span>
                    {n.body && <span className="notif-item-text">{n.body}</span>}
                  </span>
                  <span className="notif-item-time">{timeAgo(n.createdAt)}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
