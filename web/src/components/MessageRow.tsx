import { useEffect, useMemo, useRef, useState } from "react";
import { useTasks } from "../lib/hooks";
import { CircleAlert, CircleDashed, Check, Copy, MessageSquare, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useBus } from "../state/store";
import { copyText } from "../lib/clipboard";
import Avatar from "./Avatar";
import MemberHoverCard from "./MemberHoverCard";
import Tooltip from "./Tooltip";
import Attachments from "./Attachments";
import { renderMarkdown } from "../lib/md";
import { api, type Message } from "../api/client";
import {
  describeDeleteError,
  describeEditError,
  type SendErrorLike,
} from "../lib/sendError";

interface Props {
  msg: Message;
  grouped: boolean;
  meMemberId: string | undefined;
  onReact: (emoji: string) => void;
  onTogglePin?: () => void;
  onMarkUnread?: () => void;
  onOpenThread?: (msgId: string) => void;
  inThread?: boolean;
  // Public read-only viewer: hide the reaction affordances (the server refuses
  // spectator reactions, so they'd silently do nothing).
  spectator?: boolean;
  // Search jump target: flash a background so the found message is obvious.
  highlighted?: boolean;
}

const QUICK_EMOJIS = ["👍", "🎉", "✅", "👀", "🔥"];
const ROW_MIN_H = 40; // keeps virtualizer stable on hover

// Today → "3:42 PM", yesterday → "1d ago", within a week → "Nd ago",
// older → "Apr 19" (or "Apr 19, 2025" if a different year). Uses
// calendar-day diff, not raw 24h, so a 9pm post viewed at 8am next
// morning correctly reads "1d ago".
function formatMessageTs(ts: string | number | Date): string {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.floor((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return `${days}d ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

export default function MessageRow({
  msg,
  grouped,
  meMemberId,
  onReact,
  onTogglePin,
  onMarkUnread,
  onOpenThread,
  inThread,
  spectator,
  highlighted,
}: Props) {
  const dir = useBus((s) => s.directory);
  const who = dir[msg.memberId];
  const isAgent = who && (who as { kind: string }).kind === "agent";
  const [hovering, setHovering] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.bodyMd);
  // Keyboard users reach the row's own buttons/links with Tab; show the hover
  // bar while focus is (visibly) inside the row so its actions are reachable.
  const [focusWithin, setFocusWithin] = useState(false);
  const [copied, setCopied] = useState(false);
  // Failure copy for edit/delete (see describeEditError/describeDeleteError).
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  // Attachment-only messages have no text to copy.
  const canCopy = msg.bodyMd.trim().length > 0;

  async function doCopy() {
    // Copies the raw markdown as authored (mentions stay `@handle`), which is
    // also what edit shows — not the rendered HTML.
    if (await copyText(msg.bodyMd)) {
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    }
  }

  const displayName = who?.name ?? (msg.memberId === meMemberId ? "me" : msg.memberId.slice(0, 6));
  const handle = who?.handle;
  const tasksQ = useTasks();
  const taskTitles = useMemo(() => new Map((tasksQ.data?.tasks ?? []).map((t) => [t.id, t.title])), [tasksQ.data]);
  const html = useMemo(
    () => renderMarkdown(msg.bodyMd, (h) => isAgentHandle(h, dir), (id) => taskTitles.get(id)),
    [msg.bodyMd, dir, taskTitles],
  );

  const rxByEmoji: Record<string, string[]> = {};
  for (const r of msg.reactions ?? []) {
    (rxByEmoji[r.emoji] ??= []).push(r.memberId);
  }

  async function saveEdit() {
    if (draft === msg.bodyMd) {
      setEditing(false);
      setEditError(null);
      return;
    }
    // A failed save used to drop the editor and the draft with it, silently.
    // Keep editing (draft intact) and say what went wrong instead.
    try {
      await api.patch(`/messages/${msg.id}`, { bodyMd: draft });
      setEditing(false);
      setEditError(null);
    } catch (err) {
      setEditError(describeEditError(err as SendErrorLike));
    }
  }

  async function del() {
    if (!confirm("Delete this message?")) return;
    setDeleteError(null);
    try {
      await api.del(`/messages/${msg.id}`);
    } catch (err) {
      setDeleteError(describeDeleteError(err as SendErrorLike));
    }
  }

  return (
    <div
      className={`msg ${grouped ? "continued" : "first"} ${isAgent ? "agent" : ""} ${highlighted ? "msg-hit" : ""}`}
      style={{ minHeight: ROW_MIN_H }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches?.(":focus-visible")) setFocusWithin(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <div className="msg-gutter">
        {!grouped ? (
          <MemberHoverCard memberId={msg.memberId}>
            <button
              type="button"
              onClick={() => useBus.getState().openDetails(msg.memberId)}
              title={`Profile · @${handle ?? msg.memberId}`}
              className="rounded"
              aria-label={`Open ${displayName}'s profile`}
            >
              <Avatar name={displayName} color="" agent={!!isAgent} size="md" />
            </button>
          </MemberHoverCard>
        ) : (
          <div className="ts-mini">
            {formatMessageTs(msg.ts)}
          </div>
        )}
      </div>
      <div className="msg-body">
        {!grouped && (
          <div className="msg-head">
            <MemberHoverCard memberId={msg.memberId}>
              <button
                type="button"
                onClick={() => useBus.getState().openDetails(msg.memberId)}
                className="name hover:underline text-left"
              >
                {displayName}
              </button>
            </MemberHoverCard>
            {handle && <span className="handle">@{handle}</span>}
            {who && (who as { title?: string }).title ? (
              <span className="text-[11px] text-[var(--color-muted)]">· {(who as { title: string }).title}</span>
            ) : null}
            <span className="time">
              {formatMessageTs(msg.ts)}
            </span>
            {msg.editedAt && <span className="time">(edited)</span>}
            {msg.pinnedAt && (
              <span className="time" title="Pinned message" aria-label="Pinned message">
                <Pin size={11} strokeWidth={2} aria-hidden="true" style={{ display: "inline", verticalAlign: "-1px" }} /> pinned
              </span>
            )}
          </div>
        )}
        {grouped && msg.pinnedAt && (
          // Grouped rows have no header, so the pinned tag goes above the body.
          <div className="text-[11px] text-[var(--color-muted)]" title="Pinned message" aria-label="Pinned message">
            <Pin size={11} strokeWidth={2} aria-hidden="true" style={{ display: "inline", verticalAlign: "-1px" }} /> pinned
          </div>
        )}
        {!editing ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
            />
            <div className="flex gap-2 mt-1 text-[12px]">
              <button onClick={saveEdit} className="btn primary sm">Save</button>
              <button onClick={() => { setEditing(false); setEditError(null); }} className="btn ghost sm">Cancel</button>
            </div>
            {editError && (
              <div className="flex items-center gap-1.5 text-[12px] leading-5 mt-1" style={{ color: "var(--color-err)" }} role="alert">
                <CircleAlert size={12} strokeWidth={2} className="shrink-0" aria-hidden="true" />
                {editError}
              </div>
            )}
          </div>
        )}
        {deleteError && (
          <div className="flex items-center gap-1.5 text-[12px] leading-5 mt-1" style={{ color: "var(--color-err)" }} role="alert">
            <CircleAlert size={12} strokeWidth={2} className="shrink-0" aria-hidden="true" />
            {deleteError}
          </div>
        )}
        {msg.attachmentsJson?.length > 0 && (
          <Attachments files={msg.attachmentsJson} />
        )}
        {Object.keys(rxByEmoji).length > 0 && (
          <div className="reactions">
            {Object.entries(rxByEmoji).map(([emoji, mids]) => {
              const names = mids.map((mid) => {
                if (mid === meMemberId) return "you";
                const m = dir[mid] as { name?: string; handle?: string } | undefined;
                return m?.name ?? m?.handle ?? mid.slice(0, 6);
              });
              const verb = mids.length === 1 ? "reacted with" : "reacted with";
              const tip = (
                <div className="tt-reactors">
                  <div className="tt-emoji">{emoji}</div>
                  <div>
                    <strong>{formatList(names)}</strong> {verb} {emoji}
                  </div>
                </div>
              );
              return (
                <Tooltip key={emoji} content={tip}>
                  <button
                    className={`rx ${meMemberId && mids.includes(meMemberId) ? "me" : ""}`}
                    onClick={() => onReact(emoji)}
                    aria-label={`${emoji} reacted by ${names.join(", ")}`}
                  >
                    <span>{emoji}</span>
                    <span className="text-[11px]">{mids.length}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}
        {!inThread && (msg.replyCount ?? 0) > 0 && (
          <button className="replychip" onClick={() => onOpenThread?.(msg.id)}>
            {msg.replyCount} {msg.replyCount === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>
      {(hovering || focusWithin) && !editing && !(spectator && inThread && !canCopy) && (
        <div
          className="msg-hoverbar"
          onMouseDown={(e) => e.preventDefault()}
        >
          {canCopy && (
            // Read-only, so spectators get it too.
            <>
              <button
                onClick={doCopy}
                className="hb-btn"
                title={copied ? "Copied" : "Copy text"}
                aria-label={copied ? "Copied" : "Copy message text"}
              >
                {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
              </button>
              {!(spectator && inThread) && <span className="hb-sep" />}
            </>
          )}
          {!spectator && (
            <>
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  className="hb-emoji"
                  title={`React ${e}`}
                  onClick={() => onReact(e)}
                >
                  {e}
                </button>
              ))}
              <span className="hb-sep" />
            </>
          )}
          {!inThread && (
            <button onClick={() => onOpenThread?.(msg.id)} className="hb-btn" title="Reply in thread">
              <MessageSquare size={14} strokeWidth={2} />
            </button>
          )}
          {onMarkUnread && (
            <button
              onClick={onMarkUnread}
              className="hb-btn"
              title="Mark unread from here"
              aria-label="Mark unread from here"
            >
              <CircleDashed size={13} strokeWidth={2} />
            </button>
          )}
          {onTogglePin && (
            <button
              onClick={onTogglePin}
              className="hb-btn"
              title={msg.pinnedAt ? "Unpin from channel" : "Pin to channel"}
              aria-label={msg.pinnedAt ? "Unpin from channel" : "Pin to channel"}
              aria-pressed={!!msg.pinnedAt}
            >
              {msg.pinnedAt ? <PinOff size={13} strokeWidth={2} /> : <Pin size={13} strokeWidth={2} />}
            </button>
          )}
          {msg.memberId === meMemberId && (
            <>
              <button onClick={() => setEditing(true)} className="hb-btn" title="Edit">
                <Pencil size={13} strokeWidth={2} />
              </button>
              <button onClick={del} className="hb-btn hb-danger" title="Delete">
                <Trash2 size={13} strokeWidth={2} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function isAgentHandle(handle: string, dir: Record<string, unknown>): boolean {
  for (const m of Object.values(dir)) {
    const mm = m as { kind: string; handle: string };
    if (mm.handle === handle && mm.kind === "agent") return true;
  }
  return false;
}

function formatList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
