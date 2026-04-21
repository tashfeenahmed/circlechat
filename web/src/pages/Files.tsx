import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Hash, MessageSquare, Paperclip, ExternalLink, AlertTriangle, Search } from "lucide-react";
import { api } from "../api/client";

interface FileRow {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  exists: boolean;
  onDiskSize: number | null;
  messageId: string;
  conversationId: string;
  conversationKind: "channel" | "dm";
  conversationName: string | null;
  conversationOtherMemberId: string | null;
  ts: string;
  author: { name: string; handle: string; kind: "user" | "agent" } | null;
}

export default function FilesPage() {
  const [q, setQ] = useState("");
  const files = useQuery({
    queryKey: ["files"],
    queryFn: () => api.get<{ files: FileRow[] }>("/files"),
    refetchOnWindowFocus: true,
  });

  const rows = useMemo(() => {
    const all = files.data?.files ?? [];
    if (!q.trim()) return all;
    const n = q.trim().toLowerCase();
    return all.filter(
      (f) =>
        f.name.toLowerCase().includes(n) ||
        f.contentType.toLowerCase().includes(n) ||
        (f.author?.name ?? "").toLowerCase().includes(n) ||
        (f.conversationName ?? "").toLowerCase().includes(n),
    );
  }, [files.data, q]);

  const missingCount = (files.data?.files ?? []).filter((f) => !f.exists).length;

  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2">
          <FolderOpen size={15} strokeWidth={2} /> Files
        </div>
        <div className="ch-meta">
          <span>
            {(files.data?.files ?? []).length} files
            {missingCount > 0 && (
              <> · <span className="text-[var(--color-err)]">{missingCount} missing on disk</span></>
            )}
          </span>
        </div>
      </header>

      <div className="px-6 pt-3 pb-2 border-b border-[var(--color-hair)]">
        <div className="flex items-center gap-2 max-w-[420px] bg-[var(--color-bg-2)] rounded px-3 py-1.5">
          <Search size={13} strokeWidth={2} className="text-[var(--color-muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name, type, sender, channel…"
            className="flex-1 bg-transparent outline-none text-[13px]"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {files.isLoading && (
          <div className="px-6 py-10 text-center text-[13px] text-[var(--color-muted)]">Loading…</div>
        )}
        {!files.isLoading && rows.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-[var(--color-muted)]">
            No files yet. Drag-attach one in any message.
          </div>
        )}
        <ul className="divide-y divide-[var(--color-hair)]">
          {rows.map((f) => {
            const convLink =
              f.conversationKind === "channel"
                ? `/c/${f.conversationId}`
                : f.conversationOtherMemberId
                  ? `/d/${f.conversationOtherMemberId}`
                  : null;
            return (
              <li
                key={`${f.messageId}:${f.key}`}
                className={`px-6 py-2.5 flex items-center gap-3 hover:bg-[var(--color-hi)] ${
                  !f.exists ? "opacity-60" : ""
                }`}
              >
                {f.exists && f.contentType.startsWith("image/") ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="w-10 h-10 rounded overflow-hidden border border-[var(--color-hair-2)] bg-[var(--color-bg-2)] shrink-0"
                    title={f.name}
                  >
                    <img
                      src={f.url}
                      alt={f.name}
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                  </a>
                ) : (
                  <span className="w-10 h-10 rounded bg-[var(--color-bg-2)] border border-[var(--color-hair-2)] grid place-items-center text-[var(--color-muted)] shrink-0">
                    <Paperclip size={14} strokeWidth={2} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    {f.exists ? (
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[14px] font-medium text-[var(--color-ink)] hover:underline truncate"
                        title={f.name}
                      >
                        {f.name}
                      </a>
                    ) : (
                      <span className="text-[14px] font-medium text-[var(--color-muted)] line-through" title={f.name}>
                        {f.name}
                      </span>
                    )}
                    <span className="text-[11px] font-mono text-[var(--color-muted)]">
                      {formatSize(f.size)}
                    </span>
                    <span className="text-[11px] font-mono text-[var(--color-muted-2)]">
                      {f.contentType}
                    </span>
                    {!f.exists && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-err)]">
                        <AlertTriangle size={11} strokeWidth={2} /> missing
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-[var(--color-muted)] mt-0.5 inline-flex items-center gap-2 flex-wrap">
                    {convLink ? (
                      <Link to={convLink} className="inline-flex items-center gap-1 hover:underline">
                        {f.conversationKind === "channel" ? (
                          <Hash size={11} strokeWidth={2} />
                        ) : (
                          <MessageSquare size={11} strokeWidth={2} />
                        )}
                        {f.conversationKind === "channel"
                          ? f.conversationName ?? "channel"
                          : "Direct message"}
                      </Link>
                    ) : (
                      <span>—</span>
                    )}
                    <span>·</span>
                    <span>
                      {f.author?.name ?? "unknown"}
                      {f.author?.kind === "agent" && (
                        <span className="ml-1 text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted-2)]">
                          agent
                        </span>
                      )}
                    </span>
                    <span>·</span>
                    <span className="font-mono">
                      {new Date(f.ts).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span>·</span>
                    <span className="font-mono text-[var(--color-muted-2)]" title="storage key">
                      {f.key}
                    </span>
                  </div>
                </div>
                {f.exists && (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn sm ghost inline-flex items-center gap-1"
                    title="Open file"
                  >
                    <ExternalLink size={13} strokeWidth={2} /> Open
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
