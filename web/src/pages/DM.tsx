import { useParams } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import ThreadPane from "../components/ThreadPane";
import AgentActivity from "../components/AgentActivity";
import { useMessages, usePostMessage, useMe, useConversations, useMarkRead } from "../lib/hooks";
import { api } from "../api/client";
import { useBus } from "../state/store";
import Avatar from "../components/Avatar";
import { useQueryClient } from "@tanstack/react-query";

export default function DMPage() {
  const { memberId: otherMemberId } = useParams<{ memberId: string }>();
  const me = useMe();
  const convs = useConversations();
  const qc = useQueryClient();
  const dir = useBus((s) => s.directory);
  const presence = useBus((s) => s.presence);
  const threadConvId = useBus((s) => s.threadConvId);
  const threadRootId = useBus((s) => s.threadRootId);
  const openThread = useBus((s) => s.openThread);
  const closeThread = useBus((s) => s.closeThread);
  const [convId, setConvId] = useState<string | null>(null);
  const creatingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!otherMemberId || !me.data?.memberId) return;
    setConvId(null);
    const myMid = me.data.memberId;
    if (!myMid) return;
    const selfDm = otherMemberId === myMid;
    const existing = (convs.data?.conversations ?? []).find((c) =>
      c.kind !== "dm"
        ? false
        : selfDm
          ? c.memberIds.length === 1 && c.memberIds[0] === myMid
          : c.memberIds.includes(otherMemberId) && c.memberIds.includes(myMid),
    );
    if (existing) {
      setConvId(existing.id);
      return;
    }
    if (creatingRef.current === otherMemberId) return;
    creatingRef.current = otherMemberId;
    api
      .post<{ id: string }>("/conversations", {
        kind: "dm",
        memberIds: [otherMemberId],
      })
      .then(async (r) => {
        await qc.invalidateQueries({ queryKey: ["conversations"] });
        setConvId(r.id);
      })
      .finally(() => {
        creatingRef.current = null;
      });
  }, [otherMemberId, me.data?.memberId, convs.data?.conversations, qc]);

  const msgs = useMessages(convId ?? undefined);
  const post = usePostMessage(convId ?? undefined);
  const markRead = useMarkRead(convId ?? undefined);
  useEffect(() => { if (convId) markRead(); }, [convId, msgs.data?.messages.length, markRead]);

  const other = otherMemberId ? dir[otherMemberId] : undefined;
  const otherName = other?.name ?? "unknown";
  const otherAgent = (other as { kind: string } | undefined)?.kind === "agent";
  const otherHandle = (other as { handle: string } | undefined)?.handle ?? "";
  const otherStatus = otherMemberId
    ? presence[otherMemberId] ??
      (otherAgent ? "idle" : "offline")
    : undefined;

  const threadMsg = useMemo(
    () =>
      threadConvId && threadConvId === convId && threadRootId
        ? msgs.data?.messages.find((m) => m.id === threadRootId) ?? null
        : null,
    [threadConvId, threadRootId, convId, msgs.data?.messages],
  );

  return (
    <main className="flex h-full min-w-0 min-h-0 flex-1 bg-white overflow-hidden">
      <div className="workspace flex-1 min-w-0">
        <header className="chan-head">
          <Avatar name={otherName} color="" agent={otherAgent} size="sm" status={otherStatus} />
          <div className="ch-title">{otherName}</div>
          <div className="ch-meta">
            <span className="font-mono text-[12px]">@{otherHandle}</span>
            {otherAgent && <span className="tag agent ml-1">agent</span>}
          </div>
        </header>
        {convId ? (
          <>
            <MessageList
              key={convId}
              messages={msgs.data?.messages ?? []}
              meMemberId={me.data?.memberId ?? undefined}
              onOpenThread={(mid) => openThread(convId!, mid)}
            />
            <AgentActivity conversationId={convId} />
            <Composer
              placeholder={`Message ${otherName}`}
              conversationId={convId}
              onTyping={() => {
                api.post(`/conversations/${convId}/typing`).catch(() => {});
              }}
              onSend={async (bodyMd, attachments) => {
                await post.mutateAsync({ bodyMd, attachments });
              }}
            />
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-[var(--color-muted)]">
            opening conversation…
          </div>
        )}
      </div>
      {threadMsg && convId && (
        <ThreadPane
          conversationId={convId}
          rootMessage={threadMsg}
          onClose={closeThread}
        />
      )}
    </main>
  );
}
