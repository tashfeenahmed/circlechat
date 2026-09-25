import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useBus } from "../state/store";
import { parseJump } from "./searchJump";

/** A one-shot scroll target. `key` distinguishes repeat jumps to the same id. */
export interface JumpTarget {
  id: string;
  key: number;
}

let jumpSeq = 0;

// Keys of jumps a message list has already carried out (or given up on).
// Module-level rather than per-list so a list that remounts later — switching
// back to the channel, reopening a thread pane — never replays a stale jump.
const handledJumps = new Set<number>();
export function isJumpHandled(key: number): boolean {
  return handledJumps.has(key);
}
export function markJumpHandled(key: number): void {
  handledJumps.add(key);
}

/**
 * Consumes a search jump (`?m=<id>[&thread=<root>][&c=<conv>]`) for the
 * conversation `convId` currently on screen: opens the thread for replies and
 * strips the params (so Back/reload don't re-jump). Returns the target for the
 * main list (the message, or the thread root for replies) and for the thread
 * pane (the reply). Targets are scoped to the conversation they were consumed
 * for, so switching channels never carries a stale jump into another list.
 */
export function useSearchJump(convId: string | null | undefined): {
  listJump: JumpTarget | null;
  threadJump: JumpTarget | null;
} {
  const [params, setParams] = useSearchParams();
  const openThread = useBus((s) => s.openThread);
  const [state, setState] = useState<{
    convId: string;
    list: JumpTarget;
    thread: JumpTarget | null;
  } | null>(null);

  useEffect(() => {
    const p = parseJump(params);
    if (!p || !convId) return;
    // A DM link names its conversation; wait until the page has resolved it
    // (the previous DM's id can still be current for a render or two).
    if (p.convId && p.convId !== convId) return;
    setState({
      convId,
      // Replies aren't top-level rows: flash the thread root in the main list
      // and the reply itself inside the thread pane.
      list: { id: p.threadId ?? p.messageId, key: ++jumpSeq },
      thread: p.threadId ? { id: p.messageId, key: ++jumpSeq } : null,
    });
    if (p.threadId) openThread(convId, p.threadId);
    const next = new URLSearchParams(params);
    next.delete("m");
    next.delete("thread");
    next.delete("c");
    setParams(next, { replace: true });
  }, [params, convId, openThread, setParams]);

  const active = state && state.convId === convId ? state : null;
  return { listJump: active?.list ?? null, threadJump: active?.thread ?? null };
}
