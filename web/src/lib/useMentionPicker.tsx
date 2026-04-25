import React, { useEffect, useState } from "react";
import { useBus } from "../state/store";

// Reusable @-mention autocomplete state shared by the chat composer and the
// task-comment composer. Tracks the open/closed state of the picker, the
// current query, and the keyboard cursor; exposes helpers to wire onChange,
// onKeyDown, and to insert a chosen handle back into the textarea.
//
// The hook is presentation-agnostic: render the dropdown wherever it fits
// the surface (above the textarea for chat, inside the comment box for
// tasks). Both surfaces share the same .mention-menu / .mention-item CSS.

interface Member {
  memberId: string;
  handle: string;
  name: string;
  kind: string;
}

interface Opts {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  body: string;
  setBody: (v: string) => void;
  // Some surfaces (task comments) shouldn't surface @everyone — there's no
  // "all subscribers" semantic on a task. Default true for chat parity.
  includeEveryone?: boolean;
}

export function useMentionPicker({ textareaRef, body, setBody, includeEveryone = true }: Opts) {
  const dir = useBus((s) => s.directory);
  const [open, setOpen] = useState<{ q: string; at: number } | null>(null);
  const [idx, setIdx] = useState(0);

  const EVERYONE: Member = {
    memberId: "__everyone__",
    handle: "everyone",
    name: "Everyone in this conversation",
    kind: "special",
  };

  const matches: Member[] = open
    ? [...(includeEveryone ? [EVERYONE] : []), ...(Object.values(dir) as unknown as Member[])]
        .filter((m) => m.handle?.toLowerCase().startsWith(open.q))
        .slice(0, 9)
    : [];

  useEffect(() => setIdx(0), [open?.q]);

  function onChangeText(value: string, caret: number) {
    setBody(value);
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at >= 0) {
      const afterAt = upto.slice(at + 1);
      if (/^[a-z0-9._-]*$/i.test(afterAt) && (at === 0 || /\s/.test(upto[at - 1] ?? ""))) {
        setOpen({ q: afterAt.toLowerCase(), at });
        return;
      }
    }
    setOpen(null);
  }

  function pick(handle: string) {
    if (!open) return;
    const before = body.slice(0, open.at);
    const afterAt = body.slice(open.at);
    const rest = afterAt.replace(/^@[a-z0-9._-]*/i, `@${handle} `);
    setBody(before + rest);
    setOpen(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  // Returns true if the key event was consumed by the picker — the consumer
  // should bail out of its own keyboard handling on true.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || matches.length === 0) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => (i + 1) % matches.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => (i - 1 + matches.length) % matches.length); return true; }
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      const m = matches[idx];
      if (m) pick(m.handle);
      return true;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(null); return true; }
    return false;
  }

  return { open, matches, idx, setIdx, onChangeText, pick, handleKeyDown };
}

// Resolve @handles found in a body to memberIds, scoped to the workspace
// directory. Used by surfaces (task comments) where the API expects a
// mentions array of memberIds rather than parsing the body server-side.
export function resolveMentionIds(
  body: string,
  dir: Record<string, { handle?: string; memberId?: string }>,
): string[] {
  const handles = Array.from(body.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9._-]{1,39})/gi)).map((m) =>
    m[1].toLowerCase(),
  );
  if (!handles.length) return [];
  const byHandle = new Map<string, string>();
  for (const m of Object.values(dir)) {
    if (m?.handle && m?.memberId) byHandle.set(m.handle.toLowerCase(), m.memberId);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of handles) {
    const id = byHandle.get(h);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
