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
  // Older-history pagination. When the user scrolls near the top we ask the
  // parent to fetch the next older page; it gets prepended to `messages`.
  onLoadOlder?: () => void;
  hasOlder?: boolean;
  isLoadingOlder?: boolean;
}

export default function MessageList({
  messages,
  meMemberId,
  onOpenThread,
  inThread,
  onLoadOlder,
  hasOlder,
  isLoadingOlder,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const visible = messages.filter((m) => !m.deletedAt);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 12,
  });

  const prevCount = useRef(0);
  const prevFirstId = useRef<string | null>(null);
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
    prevFirstId.current = visible[0]?.id ?? null;
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
    const grew = visible.length > prevCount.current;
    const firstId = visible[0]?.id ?? null;
    // A grew-AND-first-row-changed means older history was prepended at the top
    // (scroll-up load). Anchor the viewport on the row that used to be first so
    // the page doesn't jump while the user is reading.
    const prepended = grew && prevFirstId.current !== null && firstId !== prevFirstId.current;
    if (prepended) {
      const added = visible.length - prevCount.current;
      virtualizer.scrollToIndex(added, { align: "start" });
    } else if (grew) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      const latest = visible[visible.length - 1];
      // usePostMessage inserts optimistic rows with the literal placeholder
      // memberId "me" before the server echo replaces it — both spellings are
      // "I just sent this".
      const latestIsMine =
        !!latest && (latest.memberId === "me" || (!!meMemberId && latest.memberId === meMemberId));
      // Always jump when the newest message is mine (I just sent it) —
      // otherwise only follow along if I was already near the bottom.
      if (atBottom || latestIsMine) {
        virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
      }
    }
    prevCount.current = visible.length;
    prevFirstId.current = firstId;
  }, [visible.length, virtualizer, meMemberId, visible]);

  // Load older history when the user scrolls near the top. fetchPreviousPage is
  // a no-op while a fetch is in flight, so firing on every scroll tick is safe.
  function onScroll() {
    const el = parentRef.current;
    if (!el || !onLoadOlder || !hasOlder || isLoadingOlder) return;
    if (el.scrollTop < 240) onLoadOlder();
  }

  async function react(msgId: string, emoji: string) {
    try {
      await api.post(`/messages/${msgId}/reactions`, { emoji });
    } catch {
      // ignore
    }
  }

  return (
    <div ref={parentRef} className="messages" onScroll={onScroll}>
      {isLoadingOlder && (
        <div className="ml-loading-older">Loading earlier messages…</div>
      )}
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
