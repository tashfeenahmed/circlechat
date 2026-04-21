import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Bold,
  Italic,
  Code,
  List,
  Link,
  AtSign,
  Paperclip,
  Smile,
  SendHorizontal,
  X,
} from "lucide-react";
import { api, type Attachment } from "../api/client";
import { useBus } from "../state/store";

interface Props {
  placeholder: string;
  onSend: (body: string, attachments?: Attachment[]) => Promise<void> | void;
  conversationId: string;
  onTyping?: () => void;
  hideHint?: boolean;
}

export default function Composer({ placeholder, onSend, conversationId, onTyping, hideHint }: Props) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dir = useBus((s) => s.directory);
  const [mentionOpen, setMentionOpen] = useState<{ q: string; at: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  const EVERYONE = { memberId: "__everyone__", handle: "everyone", name: "Everyone in this conversation", kind: "special" as const };
  const mentionMatches = mentionOpen
    ? [EVERYONE, ...Object.values(dir)]
        .filter((m) =>
          (m as { handle: string }).handle.toLowerCase().startsWith(mentionOpen.q),
        )
        .slice(0, 9)
    : [];

  useEffect(() => setMentionIdx(0), [mentionOpen?.q]);

  const [emojiOpen, setEmojiOpen] = useState(false);
  const EMOJIS = ["👍", "❤️", "😂", "🎉", "🔥", "🙏", "✅", "👀", "🚀", "🍜", "😊", "😢", "🤔", "💯", "👋", "🙌"];

  function applyTextareaChange(next: string, selStart: number, selEnd: number) {
    setBody(next);
    const t = ref.current;
    setTimeout(() => {
      if (!t) return;
      t.focus();
      t.setSelectionRange(selStart, selEnd);
    }, 0);
  }

  function wrap(before: string, after: string = before, placeholder = "text") {
    const t = ref.current;
    if (!t) return;
    const s = t.selectionStart ?? body.length;
    const e = t.selectionEnd ?? body.length;
    const sel = body.slice(s, e);
    const inner = sel || placeholder;
    const next = body.slice(0, s) + before + inner + after + body.slice(e);
    const selStart = s + before.length;
    const selEnd = selStart + inner.length;
    applyTextareaChange(next, selStart, selEnd);
  }

  function prefixLines(prefix: string) {
    const t = ref.current;
    if (!t) return;
    const s = t.selectionStart ?? body.length;
    const e = t.selectionEnd ?? body.length;
    const lineStart = body.lastIndexOf("\n", s - 1) + 1;
    const nextNl = body.indexOf("\n", e);
    const lineEnd = nextNl === -1 ? body.length : nextNl;
    const block = body.slice(lineStart, lineEnd) || "";
    const lines = block.length ? block.split("\n") : [""];
    const prefixed = lines.map((l) => (l.startsWith(prefix) ? l : prefix + l)).join("\n");
    const delta = prefixed.length - block.length;
    const next = body.slice(0, lineStart) + prefixed + body.slice(lineEnd);
    applyTextareaChange(next, s + prefix.length, e + delta);
  }

  function insertLink() {
    const t = ref.current;
    if (!t) return;
    const s = t.selectionStart ?? body.length;
    const e = t.selectionEnd ?? body.length;
    const sel = body.slice(s, e);
    const label = sel || "text";
    const insertion = `[${label}](url)`;
    const next = body.slice(0, s) + insertion + body.slice(e);
    const urlStart = s + 1 + label.length + 2;
    const urlEnd = urlStart + 3;
    applyTextareaChange(next, urlStart, urlEnd);
  }

  function insertAtCursor(text: string) {
    const t = ref.current;
    const s = t?.selectionStart ?? body.length;
    const e = t?.selectionEnd ?? body.length;
    const next = body.slice(0, s) + text + body.slice(e);
    const pos = s + text.length;
    applyTextareaChange(next, pos, pos);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const pick = mentionMatches[mentionIdx] as { handle: string } | undefined;
        if (pick) pickMention(pick.handle);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionOpen(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); wrap("**"); return; }
      if (k === "i") { e.preventDefault(); wrap("*"); return; }
      if (k === "e") { e.preventDefault(); wrap("`"); return; }
      if (k === "k") { e.preventDefault(); insertLink(); return; }
    }
  }

  async function submit() {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      await onSend(text, files);
      setBody("");
      setFiles([]);
      setMentionOpen(null);
      ref.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      setBody(v);
      onTyping?.();

      const caret = e.target.selectionStart;
      const upto = v.slice(0, caret);
      const at = upto.lastIndexOf("@");
      if (at >= 0) {
        const afterAt = upto.slice(at + 1);
        if (/^[a-z0-9._-]*$/i.test(afterAt) && (at === 0 || /\s/.test(upto[at - 1] ?? ""))) {
          setMentionOpen({ q: afterAt.toLowerCase(), at });
          return;
        }
      }
      setMentionOpen(null);
    },
    [onTyping],
  );

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const att = await api.upload<Attachment>("/uploads", file);
      setFiles((f) => [...f, att]);
    } catch {
      // ignore
    }
    e.target.value = "";
  }

  function pickMention(handle: string) {
    if (!mentionOpen) return;
    const before = body.slice(0, mentionOpen.at);
    const afterAt = body.slice(mentionOpen.at);
    const rest = afterAt.replace(/^@[a-z0-9._-]*/i, `@${handle} `);
    setBody(before + rest);
    setMentionOpen(null);
    setTimeout(() => ref.current?.focus(), 0);
  }

  void conversationId;
  const canSend = body.trim().length > 0 && !busy;

  return (
    <div className="composer-wrap">
      <div className="composer relative">
        {mentionOpen && mentionMatches.length > 0 && (
          <div className="mention-menu">
            {mentionMatches.map((m, i) => {
              const mm = m as { memberId: string; handle: string; name: string; kind: string };
              return (
                <button
                  key={mm.memberId}
                  onClick={() => pickMention(mm.handle)}
                  onMouseEnter={() => setMentionIdx(i)}
                  className={`mention-item ${i === mentionIdx ? "focus" : ""}`}
                >
                  <span className="mi-handle">@{mm.handle}</span>
                  <span>{mm.name}</span>
                  {mm.kind === "agent" && <span className="mi-tag">agent</span>}
                  {mm.kind === "special" && <span className="mi-tag">broadcast</span>}
                </button>
              );
            })}
          </div>
        )}

        <div className="formatbar">
          <button
            type="button"
            className="fb-btn"
            title="Bold (⌘B)"
            onMouseDown={(e) => { e.preventDefault(); wrap("**"); }}
          >
            <Bold size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="fb-btn"
            title="Italic (⌘I)"
            onMouseDown={(e) => { e.preventDefault(); wrap("*"); }}
          >
            <Italic size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="fb-btn"
            title="Code (⌘E)"
            onMouseDown={(e) => { e.preventDefault(); wrap("`"); }}
          >
            <Code size={14} strokeWidth={2} />
          </button>
          <span className="fb-sep" />
          <button
            type="button"
            className="fb-btn"
            title="List"
            onMouseDown={(e) => { e.preventDefault(); prefixLines("- "); }}
          >
            <List size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="fb-btn"
            title="Link (⌘K)"
            onMouseDown={(e) => { e.preventDefault(); insertLink(); }}
          >
            <Link size={14} strokeWidth={2} />
          </button>
          <span className="fb-sep" />
          <button
            type="button"
            className="fb-btn"
            title="Mention"
            onMouseDown={(e) => { e.preventDefault(); insertAtCursor("@"); }}
          >
            <AtSign size={14} strokeWidth={2} />
          </button>
        </div>

        <textarea
          ref={ref}
          value={body}
          onChange={onChange}
          onKeyDown={onKey}
          placeholder={placeholder}
          rows={2}
        />

        {files.length > 0 && (
          <div className="flex flex-wrap gap-1 px-3 pb-2">
            {files.map((f) => (
              <span
                key={f.key}
                className="text-[11px] bg-[var(--color-hi)] rounded px-2 py-0.5 inline-flex items-center gap-1"
              >
                <Paperclip size={11} strokeWidth={2} /> {f.name}
                <button
                  onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
                  className="text-[var(--color-muted)] inline-flex items-center"
                  title="Remove"
                >
                  <X size={11} strokeWidth={2.2} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="c-bottom">
          <label className="cb-btn cursor-pointer" title="Attach">
            <input type="file" className="hidden" onChange={upload} />
            <Paperclip size={15} strokeWidth={2} />
          </label>
          <div className="relative">
            <button
              type="button"
              className="cb-btn"
              title="Emoji"
              onMouseDown={(e) => { e.preventDefault(); setEmojiOpen((o) => !o); }}
            >
              <Smile size={15} strokeWidth={2} />
            </button>
            {emojiOpen && (
              <div
                className="absolute bottom-full mb-1 left-0 z-20 bg-white border border-[var(--color-hair-2)] rounded shadow p-1 flex flex-wrap gap-0.5 w-[184px]"
                onMouseDown={(e) => e.preventDefault()}
              >
                {EMOJIS.map((em) => (
                  <button
                    key={em}
                    type="button"
                    className="text-[16px] leading-none w-[22px] h-[22px] hover:bg-[var(--color-hi)] rounded"
                    onClick={() => {
                      insertAtCursor(em);
                      setEmojiOpen(false);
                    }}
                  >
                    {em}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={submit}
            disabled={!canSend}
            className={`send ${canSend ? "" : "dim"}`}
          >
            Send <SendHorizontal size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      {!hideHint && (
        <div className="text-[11px] text-[var(--color-muted)] mt-1 px-1">
          <b className="font-mono">Enter</b> sends · <b className="font-mono">Shift+Enter</b> newline ·{" "}
          <b className="font-mono">@</b> mentions · <b className="font-mono">↑↓</b> navigate ·{" "}
          <b className="font-mono">Tab</b> to pick
        </div>
      )}
    </div>
  );
}
