import { useEffect, useLayoutEffect, useRef } from "react";
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
  const didInitialScroll = useRef(false);

  // Pin to bottom on first paint after messages arrive. The virtualizer
  // estimates row heights with `estimateSize: 60` and only learns real heights
  // after items mount and `measureElement` runs — which can shift totalSize
  // (and therefore the real bottom) over several frames. Pin every frame for
  // ~10 frames so we converge on the actual bottom regardless of channel size,
  // image loads, or markdown height variance. Cancelled if the component
  // unmounts (channel switch).
  useLayoutEffect(() => {
    if (didInitialScroll.current || visible.length === 0 || !parentRef.current) return;
    didInitialScroll.current = true;
    prevCount.current = visible.length;
    parentRef.current.scrollTop = parentRef.current.scrollHeight;
    let frame = 0;
    let raf = 0;
    const pin = () => {
      if (!parentRef.current) return;
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
      if (++frame < 12) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [visible.length]);

  useEffect(() => {
    if (!parentRef.current || !didInitialScroll.current) return;
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
