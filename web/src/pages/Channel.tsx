import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { Trash2, Pencil, Archive, X, UserMinus, UserPlus, Bot } from "lucide-react";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import ThreadPane from "../components/ThreadPane";
import AgentActivity from "../components/AgentActivity";
import Menu from "../components/Menu";
import Avatar from "../components/Avatar";
import { useConversation, useMessages, usePostMessage, useMe, useMarkRead, useMembersDirectory } from "../lib/hooks";
import { api } from "../api/client";
import { useBus } from "../state/store";
import { useQueryClient } from "@tanstack/react-query";

export default function ChannelPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const conv = useConversation(id);
  const msgs = useMessages(id);
  const post = usePostMessage(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const threadConvId = useBus((s) => s.threadConvId);
  const threadRootId = useBus((s) => s.threadRootId);
  const openThread = useBus((s) => s.openThread);
  const closeThread = useBus((s) => s.closeThread);

  const typingMap = useBus((s) => s.typing);
  const dir = useBus((s) => s.directory);

  const markRead = useMarkRead(id);
  useEffect(() => {
    if (!id) return;
    markRead();
  }, [id, msgs.data?.messages.length, markRead]);

  const threadMsg = useMemo(
    () =>
      threadConvId === id && threadRootId
        ? msgs.data?.messages.find((m) => m.id === threadRootId) ?? null
        : null,
    [threadConvId, threadRootId, id, msgs.data?.messages],
  );

  const typingMembers = useMemo(() => {
    if (!id) return [];
    const m = typingMap[id] ?? {};
    return Object.keys(m).filter((mid) => mid !== me.data?.memberId);
  }, [typingMap, id, me.data?.memberId]);

  if (!id) return null;

  const c = conv.data?.conversation;
  const memberCount = (conv.data?.members ?? []).length;
  const myRole = (conv.data?.members ?? []).find((m) => m.memberId === me.data?.memberId)?.role;
  const isAdmin = myRole === "admin";

  const [renameOpen, setRenameOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  async function archiveChannel() {
    if (!c) return;
    const name = c.name ?? "this channel";
    if (!confirm(`Archive #${name}? It'll be hidden for everyone but history is preserved.`)) return;
    try {
      await api.post(`/conversations/${id}/archive`);
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      nav("/members");
    } catch (e) {
      alert(`Archive failed: ${(e as Error).message}`);
    }
  }

  async function hardDeleteChannel() {
    if (!c) return;
    const name = c.name ?? "this channel";
    if (
      !confirm(
        `Permanently delete #${name}? All messages, reactions, and memberships will be removed. This cannot be undone.`,
      )
    )
      return;
    if (prompt(`Type the channel name (#${name}) to confirm:`) !== name) {
      alert("Name didn't match — not deleted.");
      return;
    }
    try {
      await api.del(`/conversations/${id}`);
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      nav("/members");
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  }

  return (
    <main className="flex h-full min-w-0 min-h-0 flex-1 bg-white overflow-hidden">
      <div className="workspace flex-1 min-w-0">
        <header className="chan-head">
          <div className="ch-title">
            <span className="text-[var(--color-muted)]">#</span>
            {c?.name ?? "…"}
          </div>
          {c?.topic && (
            <div className="ch-meta">
              <span className="truncate max-w-[500px]">{c.topic}</span>
            </div>
          )}
          <div className="ch-right">
            <button onClick={() => setMembersOpen(true)} className="ch-btn">
              {memberCount} members
            </button>
            {isAdmin && (
              <Menu
                className="ch-btn"
                title="Channel actions"
                items={[
                  {
                    label: "Rename channel",
                    icon: <Pencil size={13} strokeWidth={2} />,
                    onSelect: () => setRenameOpen(true),
                  },
                  {
                    label: "Archive channel",
                    icon: <Archive size={13} strokeWidth={2} />,
                    onSelect: archiveChannel,
                  },
                  {
                    label: "Delete channel…",
                    icon: <Trash2 size={13} strokeWidth={2} />,
                    danger: true,
                    onSelect: hardDeleteChannel,
                  },
                ]}
              />
            )}
          </div>
        </header>

        <MessageList
          messages={msgs.data?.messages ?? []}
          meMemberId={me.data?.memberId ?? undefined}
          onOpenThread={(mid) => openThread(id, mid)}
        />

        <AgentActivity conversationId={id} />

        {typingMembers.length > 0 && (
          <div className="typing">
            <span className="typing-dots">
              <span /><span /><span />
            </span>
            {typingMembers
              .map((mid) => (dir[mid] as { name: string } | undefined)?.name ?? "someone")
              .join(", ")}{" "}
            is typing…
          </div>
        )}

        <Composer
          placeholder={`Message #${c?.name ?? ""}`}
          conversationId={id}
          onTyping={() => {
            api.post(`/conversations/${id}/typing`).catch(() => {
              // ignore
            });
          }}
          onSend={async (bodyMd, attachments) => {
            await post.mutateAsync({ bodyMd, attachments });
          }}
        />
      </div>

      {threadMsg && (
        <ThreadPane
          conversationId={id}
          rootMessage={threadMsg}
          onClose={closeThread}
        />
      )}
      {renameOpen && c && (
        <RenameChannelModal
          conversationId={id}
          initialName={c.name ?? ""}
          initialTopic={c.topic ?? ""}
          onClose={() => setRenameOpen(false)}
        />
      )}
      {membersOpen && (
        <ChannelMembersModal
          conversationId={id}
          memberIds={(conv.data?.members ?? []).map((m) => m.memberId)}
          canRemove={isAdmin}
          myMemberId={me.data?.memberId ?? null}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </main>
  );
}

function RenameChannelModal({
  conversationId,
  initialName,
  initialTopic,
  onClose,
}: {
  conversationId: string;
  initialName: string;
  initialTopic: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [topic, setTopic] = useState(initialTopic);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      await api.patch(`/conversations/${conversationId}`, { name, topic });
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      await qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-md border border-[var(--color-hair-2)] shadow-lg w-[480px] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--color-hair)]">
          <h2 className="text-[15px] font-semibold">Rename channel</h2>
          <button onClick={onClose} className="tb-btn" title="Close"><X size={14} strokeWidth={2} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Name</span>
            <div className="flex items-center border border-[var(--color-hair-2)] rounded overflow-hidden mt-1">
              <span className="px-2 text-[var(--color-muted)] font-mono text-[13px]">#</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 py-2 pr-2 text-[14px] outline-none"
                autoFocus
              />
            </div>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Topic</span>
            <textarea
              rows={2}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] leading-relaxed"
            />
          </label>
          {err && <p className="text-[12px] text-[var(--color-err)]">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn sm ghost">Cancel</button>
            <button onClick={save} disabled={busy || !name.trim()} className="btn sm primary">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChannelMembersModal({
  conversationId,
  memberIds,
  canRemove,
  myMemberId,
  onClose,
}: {
  conversationId: string;
  memberIds: string[];
  canRemove: boolean;
  myMemberId: string | null;
  onClose: () => void;
}) {
  const dir = useMembersDirectory();
  const qc = useQueryClient();
  const [working, setWorking] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const memberSet = useMemo(() => new Set(memberIds), [memberIds]);

  const all = useMemo(() => {
    const idx = new Map<string, { name: string; handle: string; avatarColor: string; kind: string }>();
    for (const h of dir.data?.humans ?? [])
      idx.set(h.memberId, { name: h.name, handle: h.handle, avatarColor: h.avatarColor, kind: "user" });
    for (const a of dir.data?.agents ?? [])
      idx.set(a.memberId, { name: a.name, handle: a.handle, avatarColor: a.avatarColor, kind: "agent" });
    return memberIds
      .map((mid) => ({ memberId: mid, ...(idx.get(mid) ?? { name: "unknown", handle: "unknown", avatarColor: "slate", kind: "user" }) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [dir.data, memberIds]);

  // Agents in the workspace that are NOT already in this channel — rendered
  // as a "one-click add" list so we don't make the user fish through Members.
  const availableAgents = useMemo(() => {
    return (dir.data?.agents ?? [])
      .filter((a) => !memberSet.has(a.memberId))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [dir.data, memberSet]);

  async function remove(targetMemberId: string) {
    if (!confirm(`Remove this member from the channel?`)) return;
    setErr(null);
    setWorking(targetMemberId);
    try {
      await api.del(`/conversations/${conversationId}/members/${targetMemberId}`);
      await qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      await qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  async function add(targetMemberId: string) {
    setErr(null);
    setWorking(targetMemberId);
    try {
      await api.post(`/conversations/${conversationId}/members`, {
        memberIds: [targetMemberId],
      });
      await qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      await qc.invalidateQueries({ queryKey: ["members"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50 overflow-y-auto py-6" onClick={onClose}>
      <div
        className="bg-white rounded-md border border-[var(--color-hair-2)] shadow-lg w-[460px] max-w-[92vw] flex flex-col"
        style={{ maxHeight: "calc(100vh - 48px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--color-hair)] shrink-0">
          <div>
            <h2 className="text-[15px] font-semibold">Channel members</h2>
            <p className="text-[12px] text-[var(--color-muted)] mt-0.5">{all.length} in this channel</p>
          </div>
          <button onClick={onClose} className="tb-btn" title="Close"><X size={14} strokeWidth={2} /></button>
        </div>
        {err && <div className="px-5 py-2 text-[12px] text-[var(--color-err)]">{err}</div>}
        <div className="flex-1 overflow-auto">
          <ul className="divide-y divide-[var(--color-hair)]">
            {all.map((m) => (
              <li key={m.memberId} className="px-5 py-2.5 flex items-center gap-3">
                <Avatar name={m.name} color={m.avatarColor} agent={m.kind === "agent"} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium truncate">{m.name}</div>
                  <div className="text-[11.5px] font-mono text-[var(--color-muted)] truncate">@{m.handle}</div>
                </div>
                {canRemove && m.memberId !== myMemberId && (
                  <button
                    onClick={() => remove(m.memberId)}
                    disabled={working === m.memberId}
                    className="btn sm ghost inline-flex items-center gap-1 text-[var(--color-err)]"
                    title="Remove from channel"
                  >
                    <UserMinus size={13} strokeWidth={2} /> Remove
                  </button>
                )}
              </li>
            ))}
          </ul>

          {availableAgents.length > 0 && (
            <div className="border-t border-[var(--color-hair)]">
              <div className="px-5 pt-4 pb-2 flex items-center gap-2">
                <Bot size={13} strokeWidth={2} className="text-[var(--color-muted)]" />
                <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">
                  Agents you can add
                </span>
              </div>
              <ul className="divide-y divide-[var(--color-hair)]">
                {availableAgents.map((a) => (
                  <li key={a.memberId} className="px-5 py-2.5 flex items-center gap-3">
                    <Avatar name={a.name} color={a.avatarColor} agent size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-medium truncate">{a.name}</div>
                      <div className="text-[11.5px] font-mono text-[var(--color-muted)] truncate">
                        @{a.handle}
                        {a.kind === "agent" && a.title ? ` · ${a.title}` : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => add(a.memberId)}
                      disabled={working === a.memberId}
                      className="btn sm primary inline-flex items-center gap-1"
                      title="Add to channel"
                    >
                      <UserPlus size={13} strokeWidth={2} /> {working === a.memberId ? "Adding…" : "Add"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
