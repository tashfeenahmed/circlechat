import { useMemo, useRef, useState } from "react";
import { Plus, MessageSquare, GitBranch, Link2, Calendar } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTasks, useMembersDirectory, useMe } from "../lib/hooks";
import { api, type Task, type TaskStatus } from "../api/client";
import Avatar from "./Avatar";
import TaskModal from "./TaskModal";

const COLUMNS: Array<{ id: TaskStatus; title: string; glyph: string }> = [
  { id: "backlog", title: "Backlog", glyph: "◦" },
  { id: "in_progress", title: "In progress", glyph: "●" },
  { id: "review", title: "Review", glyph: "◐" },
  { id: "done", title: "Done", glyph: "✓" },
];

function isOverdue(dueAt: string, status: TaskStatus): boolean {
  if (status === "done") return false;
  return new Date(dueAt).getTime() < Date.now();
}

export default function Board() {
  const q = useTasks();
  const qc = useQueryClient();
  const me = useMe();
  const dir = useMembersDirectory();
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [addingIn, setAddingIn] = useState<TaskStatus | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const dragIdRef = useRef<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverCol, setHoverCol] = useState<TaskStatus | null>(null);
  const [busy, setBusy] = useState(false);

  // Snapshot the board's last-seen timestamp at mount BEFORE Sidebar's effect
  // overwrites it to "now." Cards updated after this threshold get a 2px
  // black border so they're easy to spot on a busy board. Captured once per
  // mount — doesn't shift as new tasks arrive during the session.
  const workspaceId = me.data?.workspaceId ?? null;
  const [highlightAfter] = useState<number>(() => {
    if (typeof window === "undefined") return Date.now();
    const wsId = me.data?.workspaceId;
    if (!wsId) return 0;
    const raw = localStorage.getItem(`cc:boardLastSeen:${wsId}`);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : 0;
  });
  // Once a task has been highlighted and the user has looked, keep it
  // highlighted for the session — it resets next time they visit /board
  // from elsewhere. No additional state needed.
  void workspaceId;

  // Only top-level tasks appear on the board; subtasks live inside their parent.
  const topLevel = useMemo(
    () => (q.data?.tasks ?? []).filter((t) => !t.parentId),
    [q.data?.tasks],
  );

  function byCol(col: TaskStatus): Task[] {
    return topLevel
      .filter((t) => t.status === col)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  }

  async function addTask(col: TaskStatus) {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await api.post<{ task: Task }>("/tasks", {
        title,
        status: col,
        assignees: me.data?.memberId ? [me.data.memberId] : [],
      });
      setNewTitle("");
      setAddingIn(null);
    } catch (e) {
      alert(`Create failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function moveTask(taskId: string, toCol: TaskStatus, beforeId?: string | null) {
    const dest = byCol(toCol);
    const targetIdx = beforeId ? dest.findIndex((t) => t.id === beforeId) : dest.length;
    const prev = targetIdx > 0 ? dest[targetIdx - 1] : undefined;
    const next = beforeId ? dest[targetIdx] : undefined;
    let position: number;
    if (!prev && !next) position = 1;
    else if (!next && prev) position = prev.position + 1;
    else if (!prev && next) position = next.position - 1;
    else position = (prev!.position + next!.position) / 2;

    qc.setQueryData<{ tasks: Task[] }>(["tasks"], (old) =>
      old
        ? {
            tasks: old.tasks.map((t) =>
              t.id === taskId ? { ...t, status: toCol, position } : t,
            ),
          }
        : old,
    );
    try {
      await api.patch(`/tasks/${taskId}`, { status: toCol, position });
    } catch (e) {
      alert(`Move failed: ${(e as Error).message}`);
      q.refetch();
    }
  }

  const memberIdx = useMemo(() => {
    const idx = new Map<
      string,
      { name: string; handle: string; avatarColor: string; kind: "user" | "agent" }
    >();
    for (const h of dir.data?.humans ?? [])
      idx.set(h.memberId, { name: h.name, handle: h.handle, avatarColor: h.avatarColor, kind: "user" });
    for (const a of dir.data?.agents ?? [])
      idx.set(a.memberId, { name: a.name, handle: a.handle, avatarColor: a.avatarColor, kind: "agent" });
    return idx;
  }, [dir.data]);

  return (
    <div className="board-wrap">
      <div className="kanban">
        {COLUMNS.map((col) => {
          const cards = byCol(col.id);
          return (
            <div
              key={col.id}
              className={`kanban-col ${hoverCol === col.id ? "drag-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setHoverCol(col.id);
              }}
              onDragLeave={() => setHoverCol((c) => (c === col.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setHoverCol(null);
                const id = dragIdRef.current;
                if (!id) return;
                dragIdRef.current = null;
                setDragId(null);
                if (!(e.target as HTMLElement).closest(".kcard")) {
                  moveTask(id, col.id, null);
                }
              }}
            >
              <div className="kanban-col-head">
                <span className="kh-glyph">{col.glyph}</span>
                <span className="kh-title">{col.title}</span>
                <span className="kh-count">{cards.length}</span>
                <span className="kh-spacer" />
                <button
                  className="kh-menu"
                  onClick={() => setAddingIn(col.id)}
                  title="Add task"
                >
                  +
                </button>
              </div>
              <div className="kanban-col-body">
                {addingIn === col.id && (
                  <div className="kcard adding">
                    <input
                      autoFocus
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addTask(col.id);
                        if (e.key === "Escape") {
                          setAddingIn(null);
                          setNewTitle("");
                        }
                      }}
                      placeholder="Task title…"
                      className="kadd-input"
                    />
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <button
                        className="btn xs"
                        onClick={() => {
                          setAddingIn(null);
                          setNewTitle("");
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn xs primary"
                        disabled={!newTitle.trim() || busy}
                        onClick={() => addTask(col.id)}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                )}
                {cards.map((c) => {
                  const isFresh =
                    highlightAfter > 0 && Date.parse(c.updatedAt) > highlightAfter;
                  return (
                  <div
                    key={c.id}
                    className={`kcard ${dragId === c.id ? "dragging" : ""} ${isFresh ? "fresh" : ""}`}
                    draggable
                    onDragStart={() => {
                      dragIdRef.current = c.id;
                      setDragId(c.id);
                    }}
                    onDragEnd={() => {
                      dragIdRef.current = null;
                      setDragId(null);
                      setHoverCol(null);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setHoverCol(null);
                      const id = dragIdRef.current;
                      if (!id || id === c.id) {
                        dragIdRef.current = null;
                        setDragId(null);
                        return;
                      }
                      dragIdRef.current = null;
                      setDragId(null);
                      moveTask(id, col.id, c.id);
                    }}
                    onClick={() => setOpenTaskId(c.id)}
                    title={c.id}
                  >
                    <div className="kc-title">{c.title}</div>
                    {c.labels.length > 0 && (
                      <div className="kc-labels">
                        {c.labels.map((l) => (
                          <span key={l} className="kc-label">
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                    {c.progress > 0 && (
                      <div className="kc-progress">
                        <div className="kc-bar" style={{ width: c.progress + "%" }} />
                      </div>
                    )}
                    <div className="kc-foot">
                      <div className="kc-avs">
                        {c.assignees.map((mid) => {
                          const m = memberIdx.get(mid);
                          return (
                            <Avatar
                              key={mid}
                              name={m?.name ?? "?"}
                              color={m?.avatarColor ?? "slate"}
                              agent={m?.kind === "agent"}
                              size="sm"
                            />
                          );
                        })}
                      </div>
                      <span className="kc-sep" />
                      {c.dueAt && (
                        <span className={`kc-due${isOverdue(c.dueAt, c.status) ? " overdue" : ""}`}>
                          <Calendar size={11} strokeWidth={2} />
                          {new Date(c.dueAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      )}
                      {c.subtaskCount > 0 && (
                        <span className="kc-meta" title="Subtasks">
                          <GitBranch size={11} strokeWidth={2} />
                          {c.subtaskCount}
                        </span>
                      )}
                      {c.commentCount > 0 && (
                        <span className="kc-meta" title="Comments">
                          <MessageSquare size={11} strokeWidth={2} />
                          {c.commentCount}
                        </span>
                      )}
                      {c.linkCount > 0 && (
                        <span className="kc-meta" title="Links">
                          <Link2 size={11} strokeWidth={2} />
                          {c.linkCount}
                        </span>
                      )}
                    </div>
                  </div>
                  );
                })}
                <button className="kanban-col-add" onClick={() => setAddingIn(col.id)}>
                  <Plus size={12} strokeWidth={2} /> add task
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {openTaskId && (
        <TaskModal taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
      )}
    </div>
  );
}
