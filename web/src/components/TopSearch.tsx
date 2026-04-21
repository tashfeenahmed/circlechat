import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { Search, Hash, MessageSquare } from "lucide-react";
import { api } from "../api/client";
import { useMe } from "../lib/hooks";

interface Match {
  id: string;
  conversationId: string;
  parentId: string | null;
  bodyMd: string;
  ts: string;
  conversation: {
    id: string;
    kind: "channel" | "dm";
    name: string | null;
    otherMemberId?: string;
  } | null;
  author: { kind: "user" | "agent"; name: string; handle: string; avatarColor: string } | null;
}

const MIN_LEN = 2;
const DEBOUNCE_MS = 220;

export default function TopSearch() {
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<Map<string, Match[]>>(new Map());
  const me = useMe();
  const nav = useNavigate();

  // Debounced query runner with in-flight cancellation + tiny LRU cache.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < MIN_LEN) {
      setMatches(null);
      setLoading(false);
      abortRef.current?.abort();
      return;
    }
    const cached = cacheRef.current.get(needle);
    if (cached) {
      setMatches(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = window.setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const params = new URLSearchParams({ q: needle, limit: "12" });
        const res = await api.get<{ matches: Match[] }>(`/search?${params}`, { signal: ac.signal });
        cacheRef.current.set(needle, res.matches);
        if (cacheRef.current.size > 40) {
          const firstKey = cacheRef.current.keys().next().value;
          if (firstKey !== undefined) cacheRef.current.delete(firstKey);
        }
        if (!ac.signal.aborted) {
          setMatches(res.matches);
          setIdx(0);
        }
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
      } finally {
        if (abortRef.current === ac) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [q]);

  // Global shortcut: ⌘K / Ctrl+K focuses the search input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function computePos() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left, width: r.width });
  }

  useEffect(() => {
    if (!open) return;
    computePos();
    const onScroll = () => computePos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", computePos);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", computePos);
    };
  }, [open]);

  const visible = matches ?? [];

  function targetUrl(m: Match): string | null {
    const c = m.conversation;
    if (!c) return null;
    if (c.kind === "channel") return `/c/${c.id}`;
    if (c.kind === "dm" && c.otherMemberId) return `/d/${c.otherMemberId}`;
    if (c.kind === "dm" && me.data) return `/d/${me.data.memberId}`;
    return null;
  }

  function pick(m: Match) {
    const url = targetUrl(m);
    if (!url) return;
    setOpen(false);
    setQ("");
    setMatches(null);
    nav(url);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!visible.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (i + 1) % visible.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (i - 1 + visible.length) % visible.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = visible[idx];
      if (m) pick(m);
    }
  }

  const needle = q.trim();
  const showPanel = open && (needle.length >= MIN_LEN || visible.length > 0);

  return (
    <div ref={wrapRef} className="topbar-search-wrap">
      <div className="topbar-search">
        <Search size={12} strokeWidth={2} className="opacity-60" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
          placeholder="Search messages…  ⌘K"
          className="topbar-search-input"
        />
        {loading && <span className="topbar-search-spin" aria-hidden />}
      </div>
      {showPanel && pos &&
        createPortal(
          <div
            className="search-panel"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: Math.max(420, pos.width),
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {needle.length < MIN_LEN && (
              <div className="search-empty">Type at least {MIN_LEN} characters…</div>
            )}
            {needle.length >= MIN_LEN && !loading && visible.length === 0 && (
              <div className="search-empty">No matches for “{needle}”.</div>
            )}
            {visible.map((m, i) => (
              <SearchResult
                key={m.id}
                m={m}
                needle={needle}
                active={i === idx}
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(m)}
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function SearchResult({
  m,
  needle,
  active,
  onMouseEnter,
  onClick,
}: {
  m: Match;
  needle: string;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const snippet = useMemo(() => buildSnippet(m.bodyMd, needle, 90), [m.bodyMd, needle]);
  const c = m.conversation;
  const when = new Date(m.ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const convLabel =
    c?.kind === "channel"
      ? `#${c.name ?? "…"}`
      : c?.kind === "dm"
        ? "Direct message"
        : "—";
  return (
    <button
      type="button"
      className={`search-row ${active ? "active" : ""}`}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      <div className="search-row-head">
        <span className="search-row-conv">
          {c?.kind === "channel" ? (
            <Hash size={11} strokeWidth={2} />
          ) : (
            <MessageSquare size={11} strokeWidth={2} />
          )}
          {convLabel}
        </span>
        <span className="search-row-author">
          {m.author?.name ?? "unknown"}
          {m.author?.handle && (
            <span className="search-row-handle"> @{m.author.handle}</span>
          )}
        </span>
        <span className="search-row-date">{when}</span>
      </div>
      <div className="search-row-body" dangerouslySetInnerHTML={{ __html: snippet }} />
    </button>
  );
}

function buildSnippet(text: string, needle: string, around: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();
  const idx = lower.indexOf(needle.toLowerCase());
  if (idx < 0) return escapeHtml(t.slice(0, around * 2));
  const start = Math.max(0, idx - around);
  const end = Math.min(t.length, idx + needle.length + around);
  const before = (start > 0 ? "…" : "") + t.slice(start, idx);
  const match = t.slice(idx, idx + needle.length);
  const after = t.slice(idx + needle.length, end) + (end < t.length ? "…" : "");
  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
