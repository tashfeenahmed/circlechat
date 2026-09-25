import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Message } from "../api/client";
import MessageRow from "./MessageRow";
import { api } from "../api/client";
import { useSpectator, useTogglePin, useMarkUnreadFrom } from "../lib/hooks";
import { isJumpHandled, markJumpHandled, type JumpTarget } from "../lib/useSearchJump";
import { nextJumpStep } from "../lib/searchJump";

const FLASH_MS = 2600;

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
  // Search jump: scroll to this message (flashing it) instead of pinning to
  // the newest row. Pages through older history until the row is found. Each
  // target (by `key`) is handled once, so later renders never re-scroll.
  jump?: JumpTarget | null;
}

export default function MessageList({
  messages,
  meMemberId,
  onOpenThread,
  inThread,
  onLoadOlder,
  hasOlder,
  isLoadingOlder,
  jump,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const spectator = useSpectator();
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

  // Search-jump bookkeeping: how many older pages this jump has requested,
  // and the list length when it last asked (so one in-flight page is never
  // requested twice). Done-ness is tracked by key in useSearchJump.
  const jumpPages = useRef(0);
  const jumpAskedAt = useRef<number | null>(null);
  const jumpRaf = useRef(0);
  const jumpKey = useRef<number | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [jumpMissed, setJumpMissed] = useState<"gone" | "too-old" | null>(null);
  const jumpPending = !!jump && !isJumpHandled(jump.key);

  // Pin to bottom on first paint after messages arrive. The virtualizer
  // estimates row heights with `estimateSize: 60` and only learns real heights
  // after items mount and `measureElement` runs — which can shift totalSize
  // (and therefore the real bottom) over several frames. Pin every frame for
  // ~10 frames so we converge on the actual bottom regardless of channel size,
  // image loads, or markdown height variance. Cancelled if the component
  // unmounts (channel switch).
  useLayoutEffect(() => {
    if (didInitialScroll.current || visible.length === 0 || !parentRef.current) return;
    // A search jump scrolls to its own target instead — pinning to the bottom
    // first would make the viewport snap back while the jump pages into range.
    if (jumpPending && visible.some((m) => m.id === jump!.id)) {
      didInitialScroll.current = true;
      prevCount.current = visible.length;
      prevFirstId.current = visible[0]?.id ?? null;
      return;
    }
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

  // Search jump: once the target row is loaded, scroll it into view and flash
  // it. If it isn't loaded yet (older history), page backwards until it is,
  // there is nothing older, or MAX_JUMP_PAGES is hit — then say so instead of
  // silently leaving the user at the bottom. Declared after the prepend-anchor
  // effect above so, on the commit that loads the target's page, the jump
  // scroll wins over the anchor scroll.
  useEffect(() => {
    if (!jump || isJumpHandled(jump.key)) return;
    if (jumpKey.current !== jump.key) {
      // A new search replaced one still paging: start its budget afresh.
      jumpKey.current = jump.key;
      jumpPages.current = 0;
      jumpAskedAt.current = null;
    }
    const step = nextJumpStep({
      ids: visible.map((m) => m.id),
      targetId: jump.id,
      hasOlder: !!hasOlder,
      isLoadingOlder: !!isLoadingOlder,
      canLoadOlder: !!onLoadOlder,
      pagesRequested: jumpPages.current,
      askedAtLength: jumpAskedAt.current,
    });
    if (step.kind === "wait") return;
    if (step.kind === "load") {
      jumpAskedAt.current = visible.length;
      jumpPages.current += 1;
      onLoadOlder?.();
      return;
    }
    markJumpHandled(jump.key);
    jumpPages.current = 0;
    jumpAskedAt.current = null;
    if (step.kind === "miss") {
      setJumpMissed(step.reason);
      return;
    }
    setJumpMissed(null);
    const index = step.index;
    virtualizer.scrollToIndex(index, { align: "center" });
    // The row may need a frame to mount and be measured at its final
    // position; re-issue the scroll once so it lands centered.
    cancelAnimationFrame(jumpRaf.current);
    jumpRaf.current = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(index, { align: "center" }),
    );
    setFlashId(jump.id);
  }, [jump, visible, virtualizer, hasOlder, isLoadingOlder, onLoadOlder]);

  useEffect(() => () => cancelAnimationFrame(jumpRaf.current), []);
  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flashId]);
  useEffect(() => {
    if (!jumpMissed) return;
    const t = setTimeout(() => setJumpMissed(null), 6000);
    return () => clearTimeout(t);
  }, [jumpMissed]);

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

  // Pin toggling lives here so both the channel list and thread pane get it;
  // the WS `message.pinned` echo updates the row (and invalidates the pins
  // panel), so no optimistic bookkeeping is needed.
  const togglePin = useTogglePin();
  function pin(msgId: string) {
    togglePin.mutate(msgId);
  }

  // Mark-unread lives here for the same reason. The read cursor is per
  // conversation and the badge counts top-level messages only, so it's offered
  // on top-level messages (including a thread's root in the thread pane) but
  // not on replies — the API refuses those (400 thread_reply).
  const markUnread = useMarkUnreadFrom();
  function unreadFrom(msgId: string) {
    markUnread.mutate(msgId);
  }

  return (
    <div ref={parentRef} className="messages" onScroll={onScroll}>
      {isLoadingOlder && (
        <div className="ml-loading-older">
          {jumpPending ? "Finding the message…" : "Loading earlier messages…"}
        </div>
      )}
      {jumpMissed && (
        <div className="ml-jump-miss" role="status">
          {jumpMissed === "too-old"
            ? "That message is further back than we can jump — scroll up to load older history."
            : "Couldn’t find that message — it may have been deleted."}
        </div>
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
                highlighted={flashId === m.id}
                meMemberId={meMemberId}
                onReact={(e) => react(m.id, e)}
                onTogglePin={!spectator ? () => pin(m.id) : undefined}
                onMarkUnread={!spectator && !m.parentId ? () => unreadFrom(m.id) : undefined}
                onOpenThread={onOpenThread}
                inThread={inThread}
                spectator={spectator}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
