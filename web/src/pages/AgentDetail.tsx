import { useParams, useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAgent } from "../lib/hooks";
import { api } from "../api/client";
import Avatar from "../components/Avatar";
import { useQueryClient } from "@tanstack/react-query";

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useAgent(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Array<{ id: string; scope: string; action: string; status: string }>>([]);

  if (isLoading) return <div className="p-8 text-[var(--color-muted)]">loading…</div>;
  if (!data) return null;
  const { agent, channels, recentRuns } = data;

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["agent", id] });
    await qc.invalidateQueries({ queryKey: ["agents"] });
  }

  async function runTest() {
    setPending("test");
    try {
      await api.post(`/agents/${id}/test`);
    } finally {
      setPending(null);
      setTimeout(refresh, 2000);
    }
  }

  async function runHeartbeat() {
    setPending("heartbeat");
    try {
      await api.post(`/agents/${id}/run-heartbeat`);
    } finally {
      setPending(null);
      setTimeout(refresh, 2000);
    }
  }

  async function togglePause() {
    setPending("pause");
    try {
      if (agent.status === "paused") {
        await api.post(`/agents/${id}/resume`);
      } else {
        await api.post(`/agents/${id}/pause`);
      }
    } finally {
      setPending(null);
      refresh();
    }
  }

  async function loadApprovals() {
    const r = await api.get<{ approvals: Array<{ id: string; scope: string; action: string; status: string; agentId: string }> }>(
      "/approvals",
    );
    setApprovals(r.approvals.filter((a) => a.agentId === id));
  }

  async function decide(apId: string, decision: "approve" | "deny") {
    await api.post(`/approvals/${apId}`, { decision });
    await loadApprovals();
  }

  return (
    <main className="flex-1 overflow-auto bg-white">
      <div className="max-w-[800px] mx-auto px-8 py-8">
        <div className="flex items-start gap-4">
          <Avatar name={agent.name} color={agent.avatarColor} agent size="xl" />
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-[22px] font-semibold">{agent.name}</h1>
              <span className="chip chip--agent">@{agent.handle}</span>
              <span className={`chip ${agent.status === "paused" ? "bg-[var(--color-hi)]" : ""}`}>
                {agent.status}
              </span>
            </div>
            <div className="text-[12px] text-[var(--color-muted)] font-mono mt-1">
              {agent.kind} · {agent.adapter} · {agent.model || "unspecified model"}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={runTest}
              disabled={!!pending}
              title="Synthetic test trigger — smoke-tests the bridge and prompt pipeline"
              className="text-[12px] border border-[var(--color-hair-2)] rounded px-3 py-1.5 hover:bg-[var(--color-hi)]"
            >
              Test heartbeat
            </button>
            <button
              onClick={runHeartbeat}
              disabled={!!pending}
              title="Fire a real scheduled beat right now — same trigger the cron uses"
              className="text-[12px] border border-[var(--color-hair-2)] rounded px-3 py-1.5 hover:bg-[var(--color-hi)]"
            >
              Run heartbeat
            </button>
            <button
              onClick={togglePause}
              disabled={!!pending}
              className="text-[12px] border border-[var(--color-hair-2)] rounded px-3 py-1.5 hover:bg-[var(--color-hi)]"
            >
              {agent.status === "paused" ? "Resume" : "Pause"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 mt-6">
          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Brief</h2>
            <p className="text-[14px] mt-1 whitespace-pre-wrap">{agent.brief || "—"}</p>
          </section>
          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Scopes</h2>
            <div className="flex flex-wrap gap-1 mt-1">
              {agent.scopes.map((s) => (
                <span key={s} className="chip font-mono">{s}</span>
              ))}
            </div>
          </section>
          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Channels</h2>
            <div className="flex flex-wrap gap-1 mt-1">
              {channels.length === 0 && (
                <span className="text-[12px] text-[var(--color-muted-2)]">none yet</span>
              )}
              {channels.map((c) => (
                <button
                  key={c.id}
                  onClick={() => nav(`/c/${c.id}`)}
                  className="chip hover:bg-[var(--color-hi-2)]"
                >
                  {c.kind === "channel" ? `#${c.name}` : "dm"}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Heartbeat</h2>
            <p className="text-[14px] mt-1">every {agent.heartbeatIntervalSec}s</p>
          </section>
        </div>

        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">
              Approvals
            </h2>
            <button onClick={loadApprovals} className="text-[12px] text-[var(--color-muted)] hover:text-[var(--color-ink)]">
              refresh
            </button>
          </div>
          {approvals.length === 0 ? (
            <p className="text-[13px] text-[var(--color-muted-2)] italic mt-1">no pending approvals</p>
          ) : (
            <div className="space-y-2 mt-2">
              {approvals.map((a) => (
                <div key={a.id} className="border border-[var(--color-hair-2)] rounded p-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-[12px] font-mono text-[var(--color-muted)]">{a.scope}</div>
                    <div className="text-[14px]">{a.action}</div>
                  </div>
                  <button
                    onClick={() => decide(a.id, "deny")}
                    className="text-[12px] border border-[var(--color-hair-2)] rounded px-2 py-1"
                  >
                    Deny
                  </button>
                  <button
                    onClick={() => decide(a.id, "approve")}
                    className="text-[12px] bg-[var(--color-ink)] text-white rounded px-2 py-1"
                  >
                    Approve
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Recent runs</h2>
          <div className="mt-2 space-y-2">
            {recentRuns.length === 0 && (
              <p className="text-[13px] text-[var(--color-muted-2)] italic">no runs yet</p>
            )}
            {recentRuns.map((r) => (
              <div
                key={r.id}
                className="border border-[var(--color-hair)] rounded p-3 flex items-start gap-3 text-[12px]"
              >
                <span
                  className={`chip ${
                    r.status === "ok" ? "text-[var(--color-ok)]" : r.status === "failed" ? "text-[var(--color-err)]" : ""
                  }`}
                >
                  {r.status}
                </span>
                <span className="font-mono text-[var(--color-muted)]">{r.trigger}</span>
                <span className="flex-1">
                  {r.errorText ? (
                    <span className="text-[var(--color-err)]">{r.errorText}</span>
                  ) : (
                    <>
                      {(r.traceJson ?? []).slice(0, 4).join(" · ")}
                    </>
                  )}
                </span>
                <span className="text-[var(--color-muted)] font-mono">
                  {new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
