import { useMemo, useState } from "react";
import { Paperclip, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useBus } from "../state/store";
import Avatar from "./Avatar";
import MemberHoverCard from "./MemberHoverCard";
import Tooltip from "./Tooltip";
import { renderMarkdown } from "../lib/md";
import { api, type Message } from "../api/client";

interface Props {
  msg: Message;
  grouped: boolean;
  meMemberId: string | undefined;
  onReact: (emoji: string) => void;
  onOpenThread?: (msgId: string) => void;
  inThread?: boolean;
}

const QUICK_EMOJIS = ["👍", "🎉", "✅", "👀", "🔥"];
const ROW_MIN_H = 40; // keeps virtualizer stable on hover

export default function MessageRow({
  msg,
  grouped,
  meMemberId,
  onReact,
  onOpenThread,
  inThread,
}: Props) {
  const dir = useBus((s) => s.directory);
  const who = dir[msg.memberId];
  const isAgent = who && (who as { kind: string }).kind === "agent";
  const [hovering, setHovering] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.bodyMd);

  const displayName = who?.name ?? (msg.memberId === meMemberId ? "me" : msg.memberId.slice(0, 6));
  const handle = who?.handle;
  const html = useMemo(
    () => renderMarkdown(msg.bodyMd, (h) => isAgentHandle(h, dir)),
    [msg.bodyMd, dir],
  );

  const rxByEmoji: Record<string, string[]> = {};
  for (const r of msg.reactions ?? []) {
    (rxByEmoji[r.emoji] ??= []).push(r.memberId);
  }

  async function saveEdit() {
    if (draft !== msg.bodyMd) {
      try { await api.patch(`/messages/${msg.id}`, { bodyMd: draft }); } catch {}
    }
    setEditing(false);
  }

  async function del() {
    if (!confirm("Delete this message?")) return;
    try { await api.del(`/messages/${msg.id}`); } catch {}
  }

  return (
    <div
      className={`msg ${grouped ? "continued" : "first"} ${isAgent ? "agent" : ""}`}
      style={{ minHeight: ROW_MIN_H }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
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
            {new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
            {isAgent && <span className="tag agent">agent</span>}
            {who && (who as { title?: string }).title ? (
              <span className="text-[11px] text-[var(--color-muted)]">· {(who as { title: string }).title}</span>
            ) : null}
            <span className="time">
              {new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            {msg.editedAt && <span className="time">(edited)</span>}
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
              <button onClick={() => setEditing(false)} className="btn ghost sm">Cancel</button>
            </div>
          </div>
        )}
        {msg.attachmentsJson?.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {msg.attachmentsJson.map((f) =>
              f.contentType.startsWith("image/") ? (
                <a
                  key={f.key}
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="att-image"
                  title={f.name}
                >
                  <img src={f.url} alt={f.name} loading="lazy" />
                </a>
              ) : (
                <a
                  key={f.key}
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] border border-[var(--color-hair-2)] rounded px-2 py-1 text-[var(--color-ink)] hover:bg-[var(--color-hi)] inline-flex items-center gap-1"
                >
                  <Paperclip size={12} strokeWidth={2} /> {f.name}
                </a>
              ),
            )}
          </div>
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
      {hovering && !editing && (
        <div
          className="msg-hoverbar"
          onMouseDown={(e) => e.preventDefault()}
        >
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
          {!inThread && (
            <button onClick={() => onOpenThread?.(msg.id)} className="hb-btn" title="Reply in thread">
              <MessageSquare size={14} strokeWidth={2} />
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
