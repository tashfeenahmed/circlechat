import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bookmark, Hash, MessageSquare, Search } from "lucide-react";
import { useSavedItems, useToggleSave } from "../lib/hooks";
import { renderMarkdown } from "../lib/md";

export interface SavedRow {
  messageId: string;
  conversationId: string;
  parentId: string | null;
  conversationKind: "channel" | "dm";
  conversationName: string | null;
  conversationOtherMemberId: string | null;
  memberId: string;
  bodyMd: string;
  attachmentsJson: unknown[];
  msgTs: string;
  savedAt: string;
}

// Where a saved message lives, as a jump URL — same `?m=`/`?thread=`/`?c=`
// contract the top search uses (see lib/searchJump.ts), so the channel/DM
// pages scroll to and flash the message.
export function savedJumpUrl(r: SavedRow): string | null {
  const q = new URLSearchParams();
  q.set("m", r.messageId);
  if (r.parentId) q.set("thread", r.parentId);
  const qs = q.toString();
  if (r.conversationKind === "channel") return `/c/${r.conversationId}?${qs}`;
  if (!r.conversationOtherMemberId) return null;
  // DM pages resolve their conversation id asynchronously; `c=` pins it.
  return `/d/${r.conversationOtherMemberId}?${qs}&c=${r.conversationId}`;
}

export default function SavedPage() {
  const [q, setQ] = useState("");
  const items = useSavedItems();
  const toggleSave = useToggleSave();

  const rows = useMemo(() => {
    const all = items.data?.saved ?? [];
    if (!q.trim()) return all;
    const n = q.trim().toLowerCase();
    return all.filter(
      (r) =>
        r.bodyMd.toLowerCase().includes(n) ||
        (r.conversationName ?? "").toLowerCase().includes(n),
    );
  }, [items.data, q]);

  return (
    <div className="px-6 py-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <Bookmark size={16} strokeWidth={2} />
        <h1 className="text-[17px] font-semibold">Saved</h1>
      </div>
      <p className="text-[12.5px] text-[var(--color-muted)] mb-4">
        Messages you saved for later — private to you. Hover any message and hit the bookmark to
        add one.
      </p>
      <div className="relative mb-4">
        <Search size={13} strokeWidth={2} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted-2)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter saved messages…"
          aria-label="Filter saved messages"
          className="w-full bg-transparent border border-[var(--color-border)] rounded-md pl-8 pr-3 py-1.5 text-[13px] focus:outline-none focus:border-[var(--color-accent)]"
        />
      </div>
      {items.isLoading && <div className="text-[12.5px] text-[var(--color-muted)]">Loading your saved messages…</div>}
      {!items.isLoading && rows.length === 0 && (
        <div className="text-[12.5px] text-[var(--color-muted)] italic">
          Nothing saved yet. Hover a message and click the bookmark to keep it here.
        </div>
      )}
      <ul className="space-y-2">
        {rows.map((r) => {
          const jump = savedJumpUrl(r);
          return (
            <li key={r.messageId} className="border border-[var(--color-border)] rounded-md p-3">
              <div className="text-[12px] text-[var(--color-muted)] mb-1 flex items-center gap-2 flex-wrap">
                {jump ? (
                  <Link to={jump} className="inline-flex items-center gap-1 hover:underline">
                    {r.conversationKind === "channel" ? (
                      <Hash size={11} strokeWidth={2} />
                    ) : (
                      <MessageSquare size={11} strokeWidth={2} />
                    )}
                    {r.conversationKind === "channel" ? r.conversationName ?? "channel" : "Direct message"}
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare size={11} strokeWidth={2} />
                    Direct message
                  </span>
                )}
                <span className="font-mono text-[11px] text-[var(--color-muted-2)]">
                  saved {new Date(r.savedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                </span>
                <button
                  onClick={() =>
                    toggleSave.mutate({ messageId: r.messageId, convId: r.conversationId })
                  }
                  className="ml-auto text-[11px] text-[var(--color-muted)] hover:text-[var(--color-err)]"
                >
                  Remove
                </button>
              </div>
              <div
                className="text-[13px] message-body line-clamp-4"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(r.bodyMd) }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
