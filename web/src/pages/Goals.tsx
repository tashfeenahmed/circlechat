import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Target, Plus, Wand2, ChevronRight, ChevronDown } from "lucide-react";
import { api, type Goal, type Task, type PlanResult } from "../api/client";
import { humanizeError } from "../api/errors";
import { useGoals, useTasks, useMembersDirectory } from "../lib/hooks";

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  planning: "Planning…",
  in_progress: "In progress",
  done: "Done",
  archived: "Archived",
};

const PLAN_ERR_HELP: Record<string, string> = {
  planner_unconfigured: "The planner LLM isn't configured (set PLANNER_BASE_URL on the server).",
  already_planned: "This goal already has tasks — it won't re-plan.",
  no_roster: "No teammates to route work to. Add agents first.",
  plan_generation_failed: "The planner couldn't produce a valid plan. Try rephrasing the goal.",
  empty_plan: "The planner returned an empty plan. Add more detail to the goal.",
  cyclic_plan: "The generated plan had a dependency cycle. Try again.",
};

export default function GoalsPage() {
  const goalsQ = useGoals();
  const tasksQ = useTasks();
  const dir = useMembersDirectory();
  const nav = useNavigate();

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [newKind, setNewKind] = useState<"goal" | "project">("goal");
  const [newParent, setNewParent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [planning, setPlanning] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const goals = goalsQ.data?.goals ?? [];
  const autoPlan = (goalsQ.data?.autoPlan ?? "auto") === "auto";
  const tasksByGoal = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasksQ.data?.tasks ?? []) {
      if (!t.goalId) continue;
      const arr = m.get(t.goalId) ?? [];
      arr.push(t);
      m.set(t.goalId, arr);
    }
    return m;
  }, [tasksQ.data?.tasks]);

  const handleOf = (memberId: string): string => {
    const all = [...(dir.data?.humans ?? []), ...(dir.data?.agents ?? [])];
    return all.find((m) => m.memberId === memberId)?.handle ?? "unknown";
  };

  function flash(kind: "ok" | "err", msg: string) {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 5000);
  }

  async function createGoal() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.post<{ goal: Goal }>("/goals", {
        title: t,
        bodyMd: body.trim() || undefined,
        kind: newKind,
        // A project is a top-level container — never nest it under a goal.
        parentGoalId: newKind === "goal" && newParent ? newParent : undefined,
      });
      setTitle("");
      setBody("");
      setNewParent("");
      setNewKind("goal");
      setAdding(false);
    } catch (e) {
      flash("err", humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function planGoal(g: Goal) {
    if (planning) return;
    setPlanning(g.id);
    try {
      const r = await api.post<PlanResult>(`/goals/${g.id}/plan`, {});
      flash("ok", `Planned “${g.title}” → ${r.taskCount} tasks, ${r.rootCount} started.`);
      setExpanded((s) => new Set(s).add(g.id));
    } catch (e) {
      const code = (e as { body?: { error?: string } })?.body?.error ?? "";
      flash("err", PLAN_ERR_HELP[code] ?? humanizeError(e));
    } finally {
      setPlanning(null);
    }
  }

  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const active = goals.filter((g) => g.status !== "archived");

  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2">
          <Target size={15} strokeWidth={2} /> Goals
        </div>
        <div className="ch-meta">
          <span>{active.length} active</span>
          <button className="btn sm ghost ml-3 inline-flex items-center gap-1" onClick={() => setAdding((v) => !v)}>
            <Plus size={14} /> New goal
          </button>
        </div>
      </header>

      {toast && (
        <div
          className={`mx-6 mt-3 rounded-md px-3 py-2 text-[13px] ${
            toast.kind === "ok"
              ? "bg-[var(--color-accent-soft,#e8f0fe)] text-[var(--color-accent,#1a73e8)]"
              : "bg-[#fde8e8] text-[#c0392b]"
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-6">
        {adding && (
          <div className="mb-5 rounded-lg border border-[var(--color-border)] p-4 max-w-2xl">
            <input
              className="w-full bg-transparent text-[15px] font-medium outline-none mb-2"
              placeholder="What's the objective? e.g. Ship the v2 landing page"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && createGoal()}
            />
            <textarea
              className="w-full bg-transparent text-[13px] text-[var(--color-muted)] outline-none resize-none"
              placeholder="Optional detail — context, constraints, what done looks like."
              rows={2}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* Kind toggle — a project is a top-level container; a goal is a
                  unit of intent the planner decomposes (and can nest under a project). */}
              <div className="inline-flex rounded-md border border-[var(--color-border)] overflow-hidden text-[12px]">
                {(["goal", "project"] as const).map((k) => (
                  <button
                    key={k}
                    className={`px-2.5 py-1 ${newKind === k ? "bg-[var(--color-accent,#1a73e8)] text-white" : "text-[var(--color-muted)]"}`}
                    onClick={() => setNewKind(k)}
                    type="button"
                  >
                    {k === "project" ? "Project" : "Goal"}
                  </button>
                ))}
              </div>
              {newKind === "goal" && (
                <select
                  className="text-[12px] bg-transparent border border-[var(--color-border)] rounded-md px-2 py-1 outline-none"
                  value={newParent}
                  onChange={(e) => setNewParent(e.target.value)}
                  title="Nest this goal under a project or parent goal"
                >
                  <option value="">No parent (top-level)</option>
                  {active
                    .filter((p) => p.kind === "project")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        ◇ Project: {p.title}
                      </option>
                    ))}
                  {active
                    .filter((p) => p.kind !== "project")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        Goal: {p.title}
                      </option>
                    ))}
                </select>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <button className="btn sm primary" disabled={!title.trim() || busy} onClick={createGoal}>
                Create {newKind === "project" ? "project" : "goal"}
              </button>
              <button className="btn sm ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {goalsQ.isLoading && <div className="text-[13px] text-[var(--color-muted)]">Loading…</div>}
        {!goalsQ.isLoading && active.length === 0 && (
          <div className="text-[13px] text-[var(--color-muted)]">
            No goals yet. A goal is an objective the team drives toward — create one and{" "}
            {autoPlan ? (
              <>it <strong>plans itself</strong>: auto-decomposed into a task tree and routed across your agents.</>
            ) : (
              <>hit <strong>Plan</strong> to decompose it into a task tree routed across your agents.</>
            )}
          </div>
        )}

        <div className="flex flex-col gap-3 max-w-3xl">
          {active.map((g) => {
            const c = g.taskCounts;
            const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
            const isOpen = expanded.has(g.id);
            const gTasks = tasksByGoal.get(g.id) ?? [];
            const unplanned = c.total === 0 && g.status !== "planning";
            const failed = unplanned && !!g.lastPlanError;
            // In an auto workspace the planner runs itself — no button. We only
            // show a manual control when planning is OFF, or to retry a goal the
            // planner gave up on.
            const showPlanBtn = unplanned && (!autoPlan || failed);
            const isProject = g.kind === "project";
            const parent = g.parentGoalId ? goals.find((p) => p.id === g.parentGoalId) : null;
            return (
              <div
                key={g.id}
                className={`rounded-lg border ${isProject ? "border-[var(--color-accent,#1a73e8)]/40 bg-[var(--color-accent-soft,#f3f7ff)]" : "border-[var(--color-border)]"}`}
              >
                <div className="flex items-center gap-3 p-3">
                  <button className="btn xs ghost p-1" onClick={() => toggle(g.id)} title="Expand tasks">
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium truncate inline-flex items-center gap-2">
                      {isProject && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--color-accent,#1a73e8)] text-white shrink-0">
                          Project
                        </span>
                      )}
                      <span className="truncate">{g.title}</span>
                    </div>
                    <div className="text-[12px] text-[var(--color-muted)] inline-flex items-center gap-2 flex-wrap">
                      {parent && (
                        <span className="inline-flex items-center gap-1">
                          {parent.kind === "project" ? "in project" : "under"} “{parent.title}” ·
                        </span>
                      )}
                      <span>{STATUS_LABEL[g.status] ?? g.status}</span>
                      {c.total > 0 && (
                        <span>
                          · {c.done}/{c.total} tasks done
                        </span>
                      )}
                      {unplanned && autoPlan && !failed && <span>· auto-planning…</span>}
                      {failed && <span className="text-[#c0392b]">· couldn't plan ({g.lastPlanError})</span>}
                    </div>
                    {c.total > 0 && (
                      <div className="mt-1.5 h-1.5 w-full rounded-full bg-[var(--color-border)] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[var(--color-accent,#1a73e8)] transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                  {showPlanBtn && (
                    <button
                      className="btn sm primary inline-flex items-center gap-1 whitespace-nowrap"
                      disabled={planning === g.id}
                      onClick={() => planGoal(g)}
                      title={failed ? "Try planning this goal again" : "Decompose into a task tree and start it"}
                    >
                      <Wand2 size={14} />
                      {planning === g.id ? "Planning…" : failed ? "Retry" : "Plan"}
                    </button>
                  )}
                </div>

                {isOpen && (
                  <div className="border-t border-[var(--color-border)] px-3 py-2">
                    {g.bodyMd && (
                      <div className="text-[12px] text-[var(--color-muted)] mb-2 whitespace-pre-wrap">{g.bodyMd}</div>
                    )}
                    {gTasks.length === 0 ? (
                      <div className="text-[12px] text-[var(--color-muted)] py-1">
                        No tasks yet.{" "}
                        {unplanned && (autoPlan && !failed ? "Auto-planning — tasks will appear shortly." : "Plan this goal to fan it out across the team.")}
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {gTasks
                          .slice()
                          .sort((a, b) => a.status.localeCompare(b.status))
                          .map((t) => (
                            <li
                              key={t.id}
                              className="flex items-center gap-2 text-[13px] cursor-pointer hover:bg-[var(--color-hover,#f5f5f5)] rounded px-1.5 py-1"
                              onClick={() => nav(`/board?task=${t.id}`)}
                            >
                              <span className="text-[11px] tabular-nums text-[var(--color-muted)] w-[84px] shrink-0">
                                {t.status}
                                {t.blockedBy.length > 0 && " ·blocked"}
                              </span>
                              <span className="truncate flex-1">{t.title}</span>
                              {t.assignees.length > 0 && (
                                <span className="text-[11px] text-[var(--color-muted)] shrink-0">
                                  @{handleOf(t.assignees[0])}
                                </span>
                              )}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
