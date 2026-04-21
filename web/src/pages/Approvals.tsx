import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, X, ShieldAlert } from "lucide-react";
import { useApprovals, useAgents } from "../lib/hooks";
import { api } from "../api/client";
import Avatar from "../components/Avatar";
import { useQueryClient } from "@tanstack/react-query";

export default function ApprovalsPage() {
  const approvalsQ = useApprovals();
  const agentsQ = useAgents();
  const qc = useQueryClient();
  const [working, setWorking] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const agentById = useMemo(() => {
    const m = new Map<string, { name: string; handle: string; avatarColor: string; id: string }>();
    for (const a of agentsQ.data?.agents ?? []) m.set(a.id, a);
    return m;
  }, [agentsQ.data]);

  const rows = approvalsQ.data?.approvals ?? [];

  async function decide(id: string, decision: "approve" | "deny") {
    setErr(null);
    setWorking(id);
    try {
      await api.post(`/approvals/${id}`, { decision });
      await qc.invalidateQueries({ queryKey: ["approvals"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2">
          <ShieldAlert size={15} strokeWidth={2} /> Approvals
        </div>
        <div className="ch-meta">
          <span>{rows.length} pending</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {err && <div className="px-6 py-2 text-[12px] text-[var(--color-err)]">{err}</div>}
        {rows.length === 0 && (
          <div className="px-6 py-16 text-center text-[13px] text-[var(--color-muted)]">
            Nothing to review. Agents will request approval here when they need
            to do something above their current scope.
          </div>
        )}
        <ul className="divide-y divide-[var(--color-hair)]">
          {rows.map((ap) => {
            const ag = agentById.get(ap.agentId);
            const busy = working === ap.id;
            return (
              <li key={ap.id} className="px-6 py-4 flex gap-4">
                {ag ? (
                  <Link to={`/agents/${ag.id}`} className="shrink-0">
                    <Avatar name={ag.name} color={ag.avatarColor} agent size="md" />
                  </Link>
                ) : (
                  <div className="shrink-0 w-[38px] h-[38px]" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[14px] font-semibold">{ag?.name ?? "unknown agent"}</span>
                    {ag && (
                      <Link to={`/agents/${ag.id}`} className="text-[12px] font-mono text-[var(--color-muted)]">
                        @{ag.handle}
                      </Link>
                    )}
                    <span className="tag">{ap.scope}</span>
                  </div>
                  <div className="text-[13px] mt-1">{ap.action}</div>
                  {Object.keys(ap.payloadJson ?? {}).length > 0 && (
                    <pre className="mt-2 bg-[var(--color-bg-2)] border border-[var(--color-hair)] rounded p-2 text-[11.5px] font-mono overflow-auto max-h-40">
{JSON.stringify(ap.payloadJson, null, 2)}
                    </pre>
                  )}
                  <div className="text-[11.5px] text-[var(--color-muted-2)] mt-2 font-mono">
                    requested {new Date(ap.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={() => decide(ap.id, "approve")}
                    disabled={busy}
                    className="btn sm primary inline-flex items-center gap-1"
                  >
                    <Check size={13} strokeWidth={2} /> Approve
                  </button>
                  <button
                    onClick={() => decide(ap.id, "deny")}
                    disabled={busy}
                    className="btn sm ghost inline-flex items-center gap-1"
                  >
                    <X size={13} strokeWidth={2} /> Deny
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
