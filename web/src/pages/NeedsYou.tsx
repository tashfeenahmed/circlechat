import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ExternalLink, Inbox, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useSpectator } from "../lib/hooks";

type Item = {
  id: string;
  kind: string;
  priority: "critical" | "high" | "normal";
  title: string;
  detail: string;
  link: string;
  targetId: string;
  createdAt: string;
  actions: string[];
};

export default function NeedsYouPage() {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const query = useQuery<{ items: Item[]; counts: { total: number; critical: number; high: number } }>({
    queryKey: ["needs-you"],
    queryFn: () => api.get("/needs-you"),
    refetchInterval: 5_000,
  });

  async function action(item: Item, value: string) {
    setWorking(item.id); setError("");
    try {
      if (item.kind === "approval") {
        const note = window.prompt(`${value === "approve" ? "Approve" : "Deny"} with an optional note:`) ?? "";
        await api.post(`/approvals/${item.targetId}`, { decision: value, ...(note ? { note } : {}) });
      } else if (item.kind === "app_publish") {
        await api.post(`/apps/${item.targetId}/review`, { decision: value });
      } else if (item.kind === "workflow_wait" && value === "resume") {
        await api.post(`/workflow-runs/${item.targetId}/resume`, { approved: true, output: { reviewedFrom: "needs-you" } });
      } else if (item.kind === "workflow_wait" && value === "cancel") {
        await api.post(`/workflow-runs/${item.targetId}/control`, { action: "cancel", reason: "Cancelled from Needs you" });
      } else if (item.kind === "workflow_wait" && value === "steer") {
        const text = window.prompt("Steer this workflow:"); if (!text) return;
        await api.post(`/workflow-runs/${item.targetId}/control`, { action: "steer", text });
      } else if (item.kind === "connector_error" && value === "recheck") {
        await api.post(`/connectors/${item.targetId}/check`, {});
      }
      await qc.invalidateQueries({ queryKey: ["needs-you"] });
      await qc.invalidateQueries({ queryKey: ["approvals"] });
      await qc.invalidateQueries({ queryKey: ["platform", "apps"] });
    } catch (cause) { setError((cause as Error).message); }
    finally { setWorking(null); }
  }

  const items = query.data?.items ?? [];
  return <main className="workspace flex-1 min-w-0">
    <header className="chan-head"><div className="ch-title inline-flex items-center gap-2"><Inbox size={15} /> Needs you</div><div className="ch-meta"><span>{query.data?.counts.total ?? 0} open</span>{(query.data?.counts.critical ?? 0) > 0 && <span className="text-[var(--color-err)]">{query.data?.counts.critical} critical</span>}</div></header>
    <div className="flex-1 min-h-0 overflow-auto">
      {error && <div className="px-6 py-2 text-[12px] text-[var(--color-err)]">{error}</div>}
      {items.length === 0 && !query.isLoading && <div className="px-6 py-16 text-center text-[13px] text-[var(--color-muted)]">Nothing needs you. Approvals, reviews, failed verification, stalled work, budgets, app releases, and connector errors will collect here.</div>}
      <ul className="divide-y divide-[var(--color-hair)]">{items.map((item) => <li key={item.id} className="px-6 py-4 flex gap-4 items-start">
        <div className={`mt-0.5 w-8 h-8 rounded grid place-items-center ${item.priority === "critical" ? "bg-red-100 text-red-700" : item.priority === "high" ? "bg-amber-100 text-amber-800" : "bg-[var(--color-surface-2)]"}`}>{item.priority === "normal" ? <Inbox size={14} /> : <AlertTriangle size={14} />}</div>
        <div className="min-w-0 flex-1"><div className="flex gap-2 items-center"><strong className="text-[14px]">{item.title}</strong><span className="tag">{item.kind.replaceAll("_", " ")}</span><span className="tag">{item.priority}</span></div><p className="mt-1 text-[12.5px] text-[var(--color-muted)]">{item.detail}</p><p className="mt-2 text-[10.5px] font-mono text-[var(--color-muted-2)]">{new Date(item.createdAt).toLocaleString()}</p></div>
        <div className="flex gap-1 shrink-0">{item.actions.map((value) => value === "open" || value === "preview" ? <Link key={value} className="btn xs ghost" to={item.link}>{value === "preview" ? "Preview" : "Open"} <ExternalLink size={10} /></Link> : !spectator && <button key={value} className={`btn xs ${value === "approve" || value === "resume" ? "" : "ghost"}`} disabled={working === item.id} onClick={() => action(item, value)}>{value === "approve" || value === "resume" ? <Check size={10} /> : value === "deny" || value === "reject" || value === "cancel" ? <X size={10} /> : <RefreshCw size={10} />}{value.replace("_", " ")}</button>)}</div>
      </li>)}</ul>
    </div>
  </main>;
}
