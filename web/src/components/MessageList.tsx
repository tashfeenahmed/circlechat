import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Message } from "../api/client";
import MessageRow from "./MessageRow";
import { api } from "../api/client";

interface Props {
  messages: Message[];
  meMemberId: string | undefined;
  onOpenThread?: (id: string) => void;
  inThread?: boolean;
}

export default function MessageList({ messages, meMemberId, onOpenThread, inThread }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const visible = messages.filter((m) => !m.deletedAt);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 12,
  });

  const prevCount = useRef(0);
  useEffect(() => {
    if (!parentRef.current) return;
    const el = parentRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    const grew = visible.length > prevCount.current;
    const latest = visible[visible.length - 1];
    const latestIsMine = !!latest && !!meMemberId && latest.memberId === meMemberId;
    // Always jump when the newest message is mine (I just sent it) —
    // otherwise only follow along if I was already near the bottom.
    if (grew && (atBottom || latestIsMine)) {
      virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
    }
    prevCount.current = visible.length;
  }, [visible.length, virtualizer, meMemberId, visible]);

  async function react(msgId: string, emoji: string) {
    try {
      await api.post(`/messages/${msgId}/reactions`, { emoji });
    } catch {
      // ignore
    }
  }

  return (
    <div ref={parentRef} className="messages">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const m = visible[v.index];
          const prev = visible[v.index - 1];
          const grouped =
            !!prev &&
            prev.memberId === m.memberId &&
            (prev.parentId ?? null) === (m.parentId ?? null) &&
            new Date(m.ts).getTime() - new Date(prev.ts).getTime() < 5 * 60_000;
          return (
            <div
              key={m.id}
              ref={(el) => virtualizer.measureElement(el)}
              data-index={v.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${v.start}px)`,
              }}
            >
              <MessageRow
                msg={m}
                grouped={grouped}
                meMemberId={meMemberId}
                onReact={(e) => react(m.id, e)}
                onOpenThread={onOpenThread}
                inThread={inThread}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
