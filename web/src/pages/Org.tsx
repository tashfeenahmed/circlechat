import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Network, X, Search, Pencil, Link as LinkIcon, Unlink, Plus, Check } from "lucide-react";
import { api } from "../api/client";
import { humanizeError } from "../api/errors";
import Avatar from "../components/Avatar";
import { useBus } from "../state/store";

interface OrgNode {
  memberId: string;
  kind: "user" | "agent";
  name: string;
  handle: string;
  title: string;
  avatarColor: string;
  status: string | null;
  reportsTo: string | null;
  agentKind: string | null;
}

export default function OrgPage() {
  const org = useQuery({
    queryKey: ["org"],
    queryFn: () => api.get<{ nodes: OrgNode[] }>("/org"),
  });
  const [editing, setEditing] = useState<OrgNode | null>(null);
  const [addingUnder, setAddingUnder] = useState<OrgNode | null>(null);

  const nodes = org.data?.nodes ?? [];
  const byParent = useMemo(() => groupByParent(nodes), [nodes]);
  const roots = byParent.get(null) ?? [];
  const orphanCount = nodes.filter((n) => n.reportsTo && !nodes.some((x) => x.memberId === n.reportsTo)).length;

  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2">
          <Network size={15} strokeWidth={2} /> Org chart
        </div>
        <div className="ch-meta">
          <span>
            {nodes.length} members
            {roots.length > 0 && <> · {roots.length} at top</>}
            {orphanCount > 0 && <> · {orphanCount} orphan</>}
          </span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-6">
        {org.isLoading && <div className="text-[13px] text-[var(--color-muted)]">Loading…</div>}
        {!org.isLoading && nodes.length === 0 && (
          <div className="text-[13px] text-[var(--color-muted)]">No members yet.</div>
        )}
        {!org.isLoading && nodes.length > 0 && (
          <div className="org-canvas">
            {roots.length === 0 ? (
              <div className="text-[13px] text-[var(--color-muted)]">
                No one's at the top yet. Click a member's <Pencil size={12} strokeWidth={2} className="inline" /> and clear their manager to anchor the tree.
                <UnrootedList nodes={nodes} onEdit={setEditing} />
              </div>
            ) : (
              <div className="org-row">
                {roots.map((r) => (
                  <OrgBranch
                    key={r.memberId}
                    node={r}
                    byParent={byParent}
                    onEdit={setEditing}
                    onAddReport={setAddingUnder}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {editing && (
        <AssignDialog
          target={editing}
          all={nodes}
          onClose={() => setEditing(null)}
        />
      )}
      {addingUnder && (
        <NewReportDialog
          manager={addingUnder}
          onClose={() => setAddingUnder(null)}
        />
      )}
    </main>
  );
}

function groupByParent(nodes: OrgNode[]): Map<string | null, OrgNode[]> {
  const out = new Map<string | null, OrgNode[]>();
  for (const n of nodes) {
    const key = n.reportsTo && nodes.some((x) => x.memberId === n.reportsTo) ? n.reportsTo : null;
    const arr = out.get(key) ?? [];
    arr.push(n);
    out.set(key, arr);
  }
  for (const [k, arr] of out.entries()) {
    arr.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "user" ? -1 : 1));
    out.set(k, arr);
  }
  return out;
}

function OrgBranch({
  node,
  byParent,
  onEdit,
  onAddReport,
}: {
  node: OrgNode;
  byParent: Map<string | null, OrgNode[]>;
  onEdit: (n: OrgNode) => void;
  onAddReport: (n: OrgNode) => void;
}) {
  const children = byParent.get(node.memberId) ?? [];
  return (
    <div className="org-node-wrap">
      <OrgCard node={node} onEdit={() => onEdit(node)} />
      <div className="org-spine" />
      <div className="org-row children">
        {children.map((c) => (
          <OrgBranch
            key={c.memberId}
            node={c}
            byParent={byParent}
            onEdit={onEdit}
            onAddReport={onAddReport}
          />
        ))}
        <button
          type="button"
          className="org-card org-card-add"
          onClick={() => onAddReport(node)}
          title={`Add agent reporting to ${node.name}`}
        >
          <Plus size={16} strokeWidth={2.2} />
          <span className="text-[11px] mt-1">Add report</span>
        </button>
      </div>
    </div>
  );
}

function OrgCard({ node, onEdit }: { node: OrgNode; onEdit: () => void }) {
  return (
    <div className="org-card">
      <button
        type="button"
        className="org-card-body"
        onClick={() => useBus.getState().openDetails(node.memberId)}
        title="Open profile"
      >
        <Avatar
          name={node.name}
          color={node.avatarColor}
          agent={node.kind === "agent"}
          size="md"
          status={
            node.kind === "agent"
              ? node.status === "working"
                ? "working"
                : node.status === "idle" || node.status === "provisioning"
                  ? "idle"
                  : "offline"
              : undefined
          }
        />
        <div className="min-w-0 text-left">
          <div className="org-name truncate">{node.name}</div>
          <div className="org-handle truncate">@{node.handle}</div>
          {node.title && <div className="org-title truncate">{node.title}</div>}
        </div>
      </button>
      <button
        type="button"
        className="org-edit"
        title="Assign manager"
        onClick={onEdit}
      >
        <Pencil size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

function UnrootedList({ nodes, onEdit }: { nodes: OrgNode[]; onEdit: (n: OrgNode) => void }) {
  return (
    <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
      {nodes.map((n) => (
        <OrgCard key={n.memberId} node={n} onEdit={() => onEdit(n)} />
      ))}
    </div>
  );
}

// Compact Install flow for the "+ Add report" PLUS block. Minimal form — name,
// handle, runtime, provider, key (+ freeapi base URL), reports-to is fixed to
// the manager we came from.
function NewReportDialog({ manager, onClose }: { manager: OrgNode; onClose: () => void }) {
  const qc = useQueryClient();
  const [runtime, setRuntime] = useState<"hermes" | "openclaw">("hermes");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [title, setTitle] = useState("");
  const [providerId, setProviderId] = useState<"anthropic" | "openai-codex" | "openrouter" | "nous" | "custom:freeapi">("custom:freeapi");
  const [apiKey, setApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("http://localhost:3200/v1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const endpoint = runtime === "openclaw" ? "/agents/install-openclaw" : "/agents/install-hermes";
      const payload: Record<string, unknown> = {
        name,
        handle,
        title: title || undefined,
        provider: providerId,
        apiKey,
        apiBaseUrl: providerId === "custom:freeapi" ? apiBaseUrl : undefined,
        reportsTo: manager.memberId,
        heartbeatIntervalSec: 180,
      };
      if (runtime === "hermes") payload.apiKeyLabel = `${name} (${providerId})`;
      await api.post(endpoint, payload);
      await qc.invalidateQueries({ queryKey: ["org"] });
      await qc.invalidateQueries({ queryKey: ["members"] });
      onClose();
    } catch (ex) {
      setErr(humanizeError(ex));
    } finally {
      setBusy(false);
    }
  }

  const availableProviders = [
    { id: "anthropic" as const, label: "Anthropic" },
    { id: "openrouter" as const, label: "OpenRouter" },
    { id: "openai-codex" as const, label: "OpenAI" },
    ...(runtime === "hermes" ? [{ id: "nous" as const, label: "Nous" }] : []),
    { id: "custom:freeapi" as const, label: "FreeLLMAPI (self-hosted)" },
  ];

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50 overflow-y-auto py-6" onClick={onClose}>
      <form
        onSubmit={submit}
        className="bg-white rounded-md border border-[var(--color-hair-2)] shadow-lg w-[520px] max-w-[92vw] flex flex-col"
        style={{ maxHeight: "calc(100vh - 48px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--color-hair)] shrink-0">
          <div>
            <h2 className="text-[15px] font-semibold">Add agent reporting to {manager.name}</h2>
            <p className="text-[12.5px] text-[var(--color-muted)] mt-0.5">
              Docker-installed. MCP + skill wired in. You can edit everything later from Members.
            </p>
          </div>
          <button type="button" onClick={onClose} className="tb-btn" title="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Name</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Handle</span>
              <div className="mt-1 flex items-center border border-[var(--color-hair-2)] rounded overflow-hidden">
                <span className="px-2 text-[var(--color-muted)] font-mono text-[13px]">@</span>
                <input value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))} required className="flex-1 py-2 pr-2 font-mono text-[13px] outline-none" />
              </div>
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Title / role</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]" />
          </label>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Runtime</div>
            <div className="flex gap-2">
              {([
                { id: "hermes" as const, label: "Hermes", hint: "Nous Research · Docker" },
                { id: "openclaw" as const, label: "OpenClaw", hint: "alpine/openclaw · Docker" },
              ]).map((r) => {
                const selected = runtime === r.id;
                return (
                  <button key={r.id} type="button" onClick={() => setRuntime(r.id)} className={`runtime-opt ${selected ? "selected" : ""}`}>
                    <span className={`runtime-dot ${selected ? "selected" : ""}`}>{selected && <Check size={11} strokeWidth={3} />}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-medium leading-tight">{r.label}</span>
                      <span className={`block text-[11px] leading-tight mt-0.5 ${selected ? "text-[var(--color-muted)]" : "text-[var(--color-muted-2)]"}`}>{r.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Inference provider</span>
            <select value={providerId} onChange={(e) => setProviderId(e.target.value as typeof providerId)} className="cc-select mt-1">
              {availableProviders.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>

          {providerId === "custom:freeapi" && (
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Base URL</span>
              <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] font-mono" />
            </label>
          )}

          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">{providerId === "custom:freeapi" ? "Unified key" : "API key"}</span>
            <input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] font-mono" />
          </label>

          {err && <p className="text-[12px] text-[var(--color-err)]">{err}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--color-hair)] shrink-0">
          <button type="button" onClick={onClose} disabled={busy} className="btn sm ghost">Cancel</button>
          <button type="submit" disabled={busy || !name || handle.length < 2 || apiKey.length < 10} className="btn sm primary">
            {busy ? "Installing…" : "Install + link"}
          </button>
        </div>
      </form>
    </div>
  );
}

function AssignDialog({
  target,
  all,
  onClose,
}: {
  target: OrgNode;
  all: OrgNode[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Block selecting self or anyone in our subtree (server also rejects cycles).
  const forbidden = useMemo(() => {
    const s = new Set<string>([target.memberId]);
    const byParent = new Map<string, string[]>();
    for (const n of all) {
      if (!n.reportsTo) continue;
      const arr = byParent.get(n.reportsTo) ?? [];
      arr.push(n.memberId);
      byParent.set(n.reportsTo, arr);
    }
    const stack = [target.memberId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const c of byParent.get(id) ?? []) {
        if (!s.has(c)) {
          s.add(c);
          stack.push(c);
        }
      }
    }
    return s;
  }, [all, target.memberId]);

  const options = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((n) => !forbidden.has(n.memberId))
      .filter(
        (n) =>
          !needle ||
          n.name.toLowerCase().includes(needle) ||
          n.handle.toLowerCase().includes(needle) ||
          n.title.toLowerCase().includes(needle),
      )
      .slice(0, 50);
  }, [all, forbidden, q]);

  async function apply(reportsTo: string | null) {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/org/assign", { memberId: target.memberId, reportsTo });
      await qc.invalidateQueries({ queryKey: ["org"] });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-md border border-[var(--color-hair-2)] shadow-lg w-[480px] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--color-hair)]">
          <div>
            <h2 className="text-[15px] font-semibold">Manager for {target.name}</h2>
            <p className="text-[12.5px] text-[var(--color-muted)] mt-0.5">
              Pick who they report to. Affects how agents reason about chain-of-command.
            </p>
          </div>
          <button onClick={onClose} className="tb-btn" title="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2 bg-[var(--color-bg-2)] rounded px-3 py-1.5">
            <Search size={13} strokeWidth={2} className="text-[var(--color-muted)]" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter members…"
              className="flex-1 bg-transparent outline-none text-[13px]"
            />
          </div>
          {err && <p className="text-[12px] text-[var(--color-err)]">{err}</p>}
          <div className="max-h-[320px] overflow-auto border border-[var(--color-hair)] rounded">
            <button
              type="button"
              disabled={busy || target.reportsTo === null}
              onClick={() => apply(null)}
              className="w-full text-left px-3 py-2 text-[13px] flex items-center gap-2 border-b border-[var(--color-hair)] hover:bg-[var(--color-hi)]"
            >
              <Unlink size={13} strokeWidth={2} className="text-[var(--color-muted)]" />
              <span>Top of tree (no manager)</span>
            </button>
            {options.map((n) => {
              const active = target.reportsTo === n.memberId;
              return (
                <button
                  key={n.memberId}
                  type="button"
                  disabled={busy}
                  onClick={() => apply(n.memberId)}
                  className={`w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-[var(--color-hi)] ${
                    active ? "bg-[var(--color-hi)]" : ""
                  }`}
                >
                  <Avatar
                    name={n.name}
                    color={n.avatarColor}
                    agent={n.kind === "agent"}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">
                      {n.name}{" "}
                      <span className="font-mono text-[11px] text-[var(--color-muted)]">
                        @{n.handle}
                      </span>
                    </div>
                    {n.title && (
                      <div className="text-[11.5px] text-[var(--color-muted)] truncate">
                        {n.title}
                      </div>
                    )}
                  </div>
                  {active && (
                    <LinkIcon size={13} strokeWidth={2} className="text-[var(--color-ink)]" />
                  )}
                </button>
              );
            })}
            {options.length === 0 && (
              <div className="px-3 py-4 text-center text-[12px] text-[var(--color-muted)]">
                No one matches. Self and descendants are hidden to prevent cycles.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
