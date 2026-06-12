import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BarChart3, CheckCircle2, Zap, PlayCircle, ListTodo } from "lucide-react";
import { useAnalytics } from "../lib/hooks";
import Segmented from "../components/Segmented";
import Avatar from "../components/Avatar";
import type { AnalyticsAgent } from "../api/client";

type Range = "7" | "30" | "90";

// Stable per-agent chart colors: spread hues around the wheel, keep
// saturation/lightness in a band that reads on both themes.
function agentColor(i: number): string {
  return `hsl(${(i * 73 + 12) % 360} 48% 52%)`;
}

// Estimated dollars: sub-cent amounts still render as a signal (<$0.01), not $0.00.
function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - +new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<Range>("30");
  const q = useAnalytics(Number(range));
  const data = q.data;

  const colorByAgent = useMemo(() => {
    const m = new Map<string, string>();
    (data?.agents ?? []).forEach((a, i) => m.set(a.id, agentColor(i)));
    return m;
  }, [data?.agents]);

  const maxDay = useMemo(
    () =>
      Math.max(
        1,
        ...(data?.series ?? []).map((d) =>
          Object.values(d.byAgent).reduce((s, n) => s + n, 0),
        ),
      ),
    [data?.series],
  );

  const failRate =
    data && data.totals.runs > 0
      ? Math.round((data.totals.failedRuns / data.totals.runs) * 100)
      : 0;

  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2">
          <BarChart3 size={15} strokeWidth={2} /> Analytics
        </div>
        <div className="ch-meta ml-auto">
          <Segmented<Range>
            size="sm"
            ariaLabel="Time range"
            value={range}
            onChange={setRange}
            options={[
              { value: "7", label: "7d" },
              { value: "30", label: "30d" },
              { value: "90", label: "90d" },
            ]}
          />
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
        {q.isLoading && (
          <div className="py-16 text-center text-[13px] text-[var(--color-muted)]">Loading…</div>
        )}
        {data && (
          <>
            {/* totals strip */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard
                icon={<CheckCircle2 size={15} strokeWidth={2} />}
                label="Tasks completed by agents"
                value={data.totals.tasksCompleted}
                sub={data.totals.tasksCompletedByHumans > 0 ? `+${data.totals.tasksCompletedByHumans} by humans` : undefined}
                tone="ok"
              />
              <StatCard
                icon={<Zap size={15} strokeWidth={2} />}
                label="Actions applied"
                value={data.totals.actionsApplied}
                tone="accent"
              />
              <StatCard
                icon={<PlayCircle size={15} strokeWidth={2} />}
                label="Agent runs"
                value={data.totals.runs}
                sub={data.totals.failedRuns > 0 ? `${failRate}% failed` : "0 failed"}
                tone={failRate > 10 ? "err" : "muted"}
              />
              <StatCard
                icon={<ListTodo size={15} strokeWidth={2} />}
                label="Open tasks"
                value={data.totals.openTasks}
                tone="warn"
              />
              <StatCard
                icon={<Zap size={15} strokeWidth={2} />}
                label="Est. spend this month"
                value={fmtUsd(data.totals.costUsdMonth)}
                sub={`${fmtUsd(data.totals.costUsdRange)} in range`}
                tone="muted"
              />
            </div>

            {/* daily completions chart */}
            <section className="mt-6">
              <h2 className="ana-h">Tasks completed per day</h2>
              {data.totals.tasksCompleted === 0 ? (
                <div className="ana-empty">No agent task completions in this range yet.</div>
              ) : (
                <div className="ana-chart" role="img" aria-label="Daily task completions, stacked by agent">
                  {data.series.map((d) => {
                    const total = Object.values(d.byAgent).reduce((s, n) => s + n, 0);
                    const tip = `${d.date} — ${total} done${
                      total
                        ? ": " +
                          Object.entries(d.byAgent)
                            .map(([id, n]) => `@${data.agents.find((a) => a.id === id)?.handle ?? id} ${n}`)
                            .join(", ")
                        : ""
                    }`;
                    return (
                      <div key={d.date} className="ana-col" title={tip}>
                        <div className="ana-col-bars">
                          {Object.entries(d.byAgent).map(([id, n]) => (
                            <div
                              key={id}
                              style={{
                                height: `${(n / maxDay) * 100}%`,
                                background: colorByAgent.get(id) ?? "var(--color-accent)",
                              }}
                            />
                          ))}
                        </div>
                        <div className="ana-col-label">
                          {d.date.slice(8) === "01" || data.series.length <= 14 ? d.date.slice(5) : ""}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {data.agents.length > 0 && (
                <div className="ana-legend">
                  {data.agents.map((a) => (
                    <span key={a.id} className="ana-legend-item">
                      <span className="ana-swatch" style={{ background: colorByAgent.get(a.id) }} />
                      @{a.handle}
                    </span>
                  ))}
                </div>
              )}
            </section>

            {/* per-agent table */}
            <section className="mt-6">
              <h2 className="ana-h">Agents</h2>
              {data.agents.length === 0 ? (
                <div className="ana-empty">No agents in this workspace.</div>
              ) : (
                <div className="ana-table-wrap">
                  <table className="ana-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Done</th>
                        <th>Open</th>
                        <th>Runs</th>
                        <th>Actions</th>
                        <th>Msgs</th>
                        <th>Comments</th>
                        <th>Approvals</th>
                        <th title="Estimated spend this month vs the agent's monthly budget">Spend (mo)</th>
                        <th>Last active</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.agents.map((a) => (
                        <AgentRowView key={a.id} a={a} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* debugging */}
            <section className="mt-6">
              <h2 className="ana-h">Debugging</h2>
              <div className="ana-table-wrap">
                <table className="ana-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Triggers</th>
                      <th>Skipped (idle)</th>
                      <th>Runs w/ errors</th>
                      <th>Failed</th>
                      <th>Avg run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <span className="font-mono text-[12px]">@{a.handle}</span>
                        </td>
                        <td className="text-[11.5px] font-mono text-[var(--color-muted)]">
                          {Object.entries(a.runs.byTrigger)
                            .sort((x, y) => y[1] - x[1])
                            .map(([t, n]) => `${t} ${n}`)
                            .join(" · ") || "—"}
                        </td>
                        <td className="ana-num" title="Heartbeats skipped because nothing changed — no LLM call made">
                          {a.skippedRuns}
                          {a.runs.total > 0 && (
                            <span className="text-[var(--color-muted-2)]"> ({Math.round((a.skippedRuns / a.runs.total) * 100)}%)</span>
                          )}
                        </td>
                        <td className={`ana-num ${a.runsWithErrors > 0 ? "text-[var(--color-warn)]" : ""}`}>
                          {a.runsWithErrors}
                        </td>
                        <td className={`ana-num ${a.runs.failed > 0 ? "text-[var(--color-err)]" : ""}`}>
                          {a.runs.failed}
                        </td>
                        <td className="ana-num">{a.avgRunSec > 0 ? `${a.avgRunSec}s` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.topErrors.length > 0 && (
                <div className="mt-3">
                  <h3 className="ana-h">Top run errors (normalized)</h3>
                  <ul className="ana-errlist">
                    {data.topErrors.map((e) => (
                      <li key={e.reason}>
                        <span className="ana-errcount">{e.count}×</span>
                        <span className="ana-errmsg">{e.reason}</span>
                        <span className="ana-erragents">{e.agents.map((h) => `@${h}`).join(" ")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            {/* recent completions */}
            <section className="mt-6 pb-8">
              <h2 className="ana-h">Recent completions</h2>
              {data.recentCompletions.length === 0 ? (
                <div className="ana-empty">Nothing marked done in this range.</div>
              ) : (
                <ul className="divide-y divide-[var(--color-hair)]">
                  {data.recentCompletions.map((c) => (
                    <li key={`${c.taskId}-${c.ts}`} className="py-2 flex items-baseline gap-2 text-[13px]">
                      <CheckCircle2 size={13} strokeWidth={2} className="self-center shrink-0 text-[var(--color-ok)]" />
                      <Link to={`/board?task=${c.taskId}`} className="truncate hover:underline">
                        {c.title}
                      </Link>
                      <span className="text-[12px] text-[var(--color-muted)] shrink-0">
                        by @{c.byHandle}
                        {c.byKind === "user" ? " (human)" : ""}
                      </span>
                      <span className="ml-auto text-[11.5px] font-mono text-[var(--color-muted-2)] shrink-0">
                        {fmtAgo(c.ts)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub?: string;
  tone: "ok" | "warn" | "err" | "accent" | "muted";
}) {
  const color =
    tone === "ok"
      ? "var(--color-ok)"
      : tone === "warn"
        ? "var(--color-warn)"
        : tone === "err"
          ? "var(--color-err)"
          : tone === "accent"
            ? "var(--color-accent)"
            : "var(--color-muted)";
  return (
    <div className="ana-card">
      <div className="ana-card-top" style={{ color }}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="ana-card-value">{value}</div>
      {sub && <div className="ana-card-sub">{sub}</div>}
    </div>
  );
}

function AgentRowView({ a }: { a: AnalyticsAgent }) {
  const open = a.tasksOpen.backlog + a.tasksOpen.in_progress + a.tasksOpen.review;
  return (
    <tr>
      <td>
        <Link to={`/agents/${a.id}`} className="inline-flex items-center gap-2 hover:underline">
          <Avatar name={a.name} color={a.avatarColor} agent size="sm" status={a.status} />
          <span className="font-semibold">{a.name}</span>
          <span className="font-mono text-[11.5px] text-[var(--color-muted)]">@{a.handle}</span>
        </Link>
      </td>
      <td className="ana-num text-[var(--color-ok)] font-semibold">{a.tasksCompleted}</td>
      <td
        className="ana-num"
        title={`backlog ${a.tasksOpen.backlog} · in progress ${a.tasksOpen.in_progress} · review ${a.tasksOpen.review}`}
      >
        {open}
      </td>
      <td className="ana-num" title={Object.entries(a.runs.byTrigger).map(([t, n]) => `${t} ${n}`).join(" · ")}>
        {a.runs.total}
        {a.runs.failed > 0 && <span className="text-[var(--color-err)]"> ({a.runs.failed}✗)</span>}
      </td>
      <td className="ana-num">{a.actionsApplied}</td>
      <td className="ana-num">{a.messages}</td>
      <td className="ana-num">{a.taskComments}</td>
      <td className="ana-num">
        {a.approvalsPending > 0 ? (
          <Link to="/approvals" className="text-[var(--color-warn)] hover:underline">
            {a.approvalsPending}
          </Link>
        ) : (
          0
        )}
      </td>
      <td
        className="ana-num"
        title={
          a.budgetUsdMonth != null
            ? `$${a.costUsdMonth.toFixed(2)} of $${a.budgetUsdMonth.toFixed(2)} monthly budget (estimated)`
            : "Estimated spend this month — no budget set"
        }
      >
        {fmtUsd(a.costUsdMonth)}
        {a.budgetUsdMonth != null && (
          <span
            className={
              a.pauseReason === "budget" || a.costUsdMonth >= a.budgetUsdMonth
                ? "text-[var(--color-err)]"
                : a.costUsdMonth >= a.budgetUsdMonth * 0.8
                  ? "text-[var(--color-warn)]"
                  : "text-[var(--color-muted-2)]"
            }
          >
            {" "}/ {fmtUsd(a.budgetUsdMonth)}
          </span>
        )}
      </td>
      <td className="text-[11.5px] font-mono text-[var(--color-muted-2)]">{fmtAgo(a.lastActiveAt)}</td>
    </tr>
  );
}
