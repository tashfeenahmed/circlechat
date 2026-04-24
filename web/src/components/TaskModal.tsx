import { useEffect, useMemo, useRef, useState } from "react";
import { X, Plus, Trash2, Paperclip, Bold, Italic, Code, ChevronDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTaskDetail, useMembersDirectory, useMe } from "../lib/hooks";
import {
  api,
  type TaskStatus,
  type Task,
  type TaskComment as TaskCommentRow,
  type TaskDetail,
} from "../api/client";
import Avatar from "./Avatar";
import Attachments from "./Attachments";

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};
const ALL_STATUSES: TaskStatus[] = ["backlog", "in_progress", "review", "done"];

export default function TaskModal({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const q = useTaskDetail(taskId);
  const me = useMe();
  const qc = useQueryClient();
  const dir = useMembersDirectory();

  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [subDraft, setSubDraft] = useState("");
  const [linkDraft, setLinkDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [assignPickerOpen, setAssignPickerOpen] = useState(false);
  const [assignFilter, setAssignFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const composerTaRef = useRef<HTMLTextAreaElement>(null);
  const bodyTouched = useRef(false);
  const titleTouched = useRef(false);

  const detail = q.data;

  // Reset local drafts when the task changes.
  useEffect(() => {
    if (detail?.task) {
      if (!titleTouched.current) setTitleDraft(detail.task.title);
      if (!bodyTouched.current) setBodyDraft(detail.task.bodyMd ?? "");
    }
  }, [detail?.task?.id]);

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

  const allMembers = useMemo(() => {
    const out: Array<{ memberId: string; name: string; handle: string; kind: "user" | "agent"; color: string }> = [];
    for (const h of dir.data?.humans ?? [])
      out.push({
        memberId: h.memberId,
        name: h.name,
        handle: h.handle,
        kind: "user",
        color: h.avatarColor,
      });
    for (const a of dir.data?.agents ?? [])
      out.push({
        memberId: a.memberId,
        name: a.name,
        handle: a.handle,
        kind: "agent",
        color: a.avatarColor,
      });
    return out;
  }, [dir.data]);

  async function patchTask(patch: Partial<Task>) {
    if (!detail?.task) return;
    await api.patch(`/tasks/${taskId}`, patch);
    qc.invalidateQueries({ queryKey: ["task", taskId] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function saveTitle() {
    if (!detail?.task) return;
    const next = titleDraft.trim();
    if (!next || next === detail.task.title) {
      titleTouched.current = false;
      return;
    }
    await patchTask({ title: next });
    titleTouched.current = false;
  }
  async function saveBody() {
    if (!detail?.task) return;
    if (bodyDraft === detail.task.bodyMd) {
      bodyTouched.current = false;
      return;
    }
    await patchTask({ bodyMd: bodyDraft });
    bodyTouched.current = false;
  }

  async function postComment() {
    const body = commentDraft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${taskId}/comments`, { bodyMd: body });
      setCommentDraft("");
    } catch (e) {
      alert(`Comment failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function createSubtask() {
    const title = subDraft.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await api.post("/tasks", {
        title,
        parentId: taskId,
      });
      setSubDraft("");
      qc.invalidateQueries({ queryKey: ["task", taskId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    } catch (e) {
      alert(`Subtask failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleSubStatus(sub: Task) {
    await api.patch(`/tasks/${sub.id}`, {
      status: sub.status === "done" ? "backlog" : "done",
    });
    qc.invalidateQueries({ queryKey: ["task", taskId] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function addLink() {
    const linkedTaskId = linkDraft.trim();
    if (!linkedTaskId || busy) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${taskId}/links`, { linkedTaskId, kind: "relates" });
      setLinkDraft("");
      qc.invalidateQueries({ queryKey: ["task", taskId] });
    } catch (e) {
      alert(`Link failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeLink(linkId: string) {
    await api.del(`/tasks/${taskId}/links/${linkId}`);
    qc.invalidateQueries({ queryKey: ["task", taskId] });
  }

  async function addLabel() {
    const label = labelDraft.trim();
    if (!label || !detail?.task) return;
    const next = Array.from(new Set([...(detail.task.labels ?? []), label]));
    await api.put(`/tasks/${taskId}/labels`, { labels: next });
    setLabelDraft("");
    qc.invalidateQueries({ queryKey: ["task", taskId] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  }
  async function removeLabel(label: string) {
    if (!detail?.task) return;
    const next = (detail.task.labels ?? []).filter((l) => l !== label);
    await api.put(`/tasks/${taskId}/labels`, { labels: next });
    qc.invalidateQueries({ queryKey: ["task", taskId] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function addAssignee(memberId: string) {
    await api.post(`/tasks/${taskId}/assignees`, { memberId });
    setAssignPickerOpen(false);
    setAssignFilter("");
    qc.invalidateQueries({ queryKey: ["task", taskId] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  }
  async function removeAssignee(memberId: string) {
    await api.del(`/tasks/${taskId}/assignees/${memberId}`);
    qc.invalidateQueries({ queryKey: ["task", taskId] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function deleteTask() {
    if (!detail?.task) return;
    if (!confirm(`Delete "${detail.task.title}"? All subtasks, comments, and links will be removed.`)) return;
    await api.del(`/tasks/${taskId}`);
    qc.invalidateQueries({ queryKey: ["tasks"] });
    onClose();
  }

  if (!detail) {
    return (
      <div className="modal-bg" onClick={onClose}>
        <div className="modal task-modal" onClick={(e) => e.stopPropagation()}>
          <div className="task-modal-head">
            <div className="mono text-[12px] text-[var(--color-muted)]">loading…</div>
            <button className="tb-btn" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const t = detail.task;
  const filteredMembers = allMembers
    .filter((m) => !t.assignees.includes(m.memberId))
    .filter(
      (m) =>
        !assignFilter ||
        m.name.toLowerCase().includes(assignFilter.toLowerCase()) ||
        m.handle.toLowerCase().includes(assignFilter.toLowerCase()),
    );

  const completedSubs = detail.subtasks.filter((s) => s.status === "done").length;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal task-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="mono text-[11px] text-[var(--color-muted)]">{t.id}</span>
          <span className="tm-head-spacer" />
          <button className="tb-btn" onClick={deleteTask} title="Delete task">
            <Trash2 size={14} />
          </button>
          <button className="tb-btn" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="task-modal-body tm-split">
          <div className="tm-main">
            <input
              className="tm-title"
              value={titleDraft}
              onChange={(e) => {
                titleTouched.current = true;
                setTitleDraft(e.target.value);
              }}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <textarea
              className="tm-body"
              placeholder="Add a description…"
              rows={3}
              value={bodyDraft}
              onChange={(e) => {
                bodyTouched.current = true;
                setBodyDraft(e.target.value);
              }}
              onBlur={saveBody}
            />

            <section className="tm-section">
              <div className="tm-section-head">
                <span className="tm-section-title">Subtasks</span>
                {detail.subtasks.length > 0 && (
                  <span className="tm-section-count">
                    {completedSubs}/{detail.subtasks.length}
                  </span>
                )}
              </div>
              <ul className="tm-sub-list">
                {detail.subtasks.map((s) => (
                  <li key={s.id} className="tm-sub-item">
                    <input
                      type="checkbox"
                      checked={s.status === "done"}
                      onChange={() => toggleSubStatus(s)}
                    />
                    <span className={s.status === "done" ? "tm-sub-done" : ""}>{s.title}</span>
                  </li>
                ))}
              </ul>
              <div className="tm-sub-add">
                <input
                  value={subDraft}
                  onChange={(e) => setSubDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createSubtask();
                  }}
                  placeholder="+ subtask"
                  className="tm-sub-input"
                />
              </div>
            </section>

            <section className="tm-section">
            <div className="tm-section-head">
              <span className="tm-section-title">Comments</span>
              <span className="tm-section-count">{detail.comments.length}</span>
            </div>
            <ul className="tm-comments">
              {detail.comments.map((c) => {
                const m = memberIdx.get(c.memberId);
                const mine = me.data?.memberId === c.memberId;
                const t = new Date(c.ts);
                return (
                  <li key={c.id} className="tm-comment-msg">
                    <div className="tm-comment-gutter">
                      <Avatar
                        name={m?.name ?? "?"}
                        color={m?.avatarColor ?? "slate"}
                        agent={m?.kind === "agent"}
                        size="sm"
                      />
                    </div>
                    <div className="tm-comment-body">
                      <div className="msg-head">
                        <span className="name">{m?.name ?? c.memberId.slice(0, 8)}</span>
                        {m?.handle && (
                          <span className="handle">@{m.handle}</span>
                        )}
                        <span className="time" title={t.toLocaleString()}>
                          {t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        </span>
                        {mine && (
                          <button
                            className="tm-chip-x"
                            title="Delete"
                            onClick={async () => {
                              await api.del(`/tasks/${taskId}/comments/${c.id}`);
                              qc.invalidateQueries({ queryKey: ["task", taskId] });
                            }}
                          >
                            <X size={10} />
                          </button>
                        )}
                      </div>
                      <div className="msg-body">
                        {c.bodyMd && <p>{c.bodyMd}</p>}
                        {c.attachmentsJson?.length > 0 && (
                          <Attachments files={c.attachmentsJson} />
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className={`tm-composer ${composerOpen ? "open" : ""}`}>
              <div className="tm-composer-gutter">
                <Avatar
                  name={me.data?.user?.name ?? "?"}
                  color={(me.data?.user?.avatarColor as string) ?? "slate"}
                  size="sm"
                />
              </div>
              {!composerOpen ? (
                <button
                  type="button"
                  className="tm-composer-prompt"
                  onClick={() => {
                    setComposerOpen(true);
                    setTimeout(() => composerTaRef.current?.focus(), 0);
                  }}
                >
                  Add a comment…
                </button>
              ) : (
                <div className="tm-composer-editor">
                  <div className="tm-composer-toolbar">
                    <button type="button" title="Bold" className="tm-tool"><Bold size={12} strokeWidth={2.2} /></button>
                    <button type="button" title="Italic" className="tm-tool"><Italic size={12} strokeWidth={2.2} /></button>
                    <button type="button" title="Code" className="tm-tool"><Code size={12} strokeWidth={2.2} /></button>
                    <span className="tm-tool-sep" />
                    <button type="button" title="Attach" className="tm-tool"><Paperclip size={12} strokeWidth={2.2} /></button>
                  </div>
                  <textarea
                    ref={composerTaRef}
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    placeholder="Write a comment — ⌘↵ to save, Esc to cancel"
                    rows={4}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        postComment().then(() => setComposerOpen(false));
                      } else if (e.key === "Escape") {
                        setComposerOpen(false);
                        setCommentDraft("");
                      }
                    }}
                  />
                  <div className="tm-composer-actions">
                    <button
                      className="btn sm primary"
                      onClick={async () => {
                        await postComment();
                        setComposerOpen(false);
                      }}
                      disabled={!commentDraft.trim() || busy}
                    >
                      Save
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        setComposerOpen(false);
                        setCommentDraft("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="tm-section">
            <div className="tm-section-head">
              <span className="tm-section-title">Activity</span>
            </div>
            <ul className="tm-activity">
              {detail.activity.slice(0, 8).map((a) => {
                const who = memberIdx.get(a.actorMemberId);
                return (
                  <li key={a.id} className="tm-activity-row mono text-[11px] text-[var(--color-muted)]">
                    <span>{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <span>·</span>
                    <span>{formatActivity(a)}</span>
                    <span>·</span>
                    <span>by @{who?.handle ?? a.actorMemberId.slice(0, 6)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
          </div>

          <aside className="tm-rail">
            <div className="tm-rail-field">
              <div className="tm-rail-label">Status</div>
              <div className="tm-rail-status-wrap">
                <button
                  className={`tm-rail-status s-${t.status}`}
                  onClick={() => setStatusMenuOpen((o) => !o)}
                >
                  <span className="tm-status-dot" />
                  <span>{STATUS_LABELS[t.status]}</span>
                  <ChevronDown size={12} strokeWidth={2.2} />
                </button>
                {statusMenuOpen && (
                  <div className="tm-popover tm-status-popover">
                    <ul className="tm-popover-list">
                      {ALL_STATUSES.map((s) => (
                        <li key={s}>
                          <button
                            className={`tm-popover-item tm-status-item s-${s} ${t.status === s ? "on" : ""}`}
                            onClick={() => {
                              patchTask({ status: s });
                              setStatusMenuOpen(false);
                            }}
                          >
                            <span className="tm-status-dot" />
                            <span>{STATUS_LABELS[s]}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <div className="tm-rail-field">
              <div className="tm-rail-label">Assignees</div>
              <div className="tm-av-row">
                {t.assignees.map((mid) => {
                  const m = memberIdx.get(mid);
                  return (
                    <span key={mid} className="tm-chip">
                      <Avatar
                        name={m?.name ?? "?"}
                        color={m?.avatarColor ?? "slate"}
                        agent={m?.kind === "agent"}
                        size="sm"
                      />
                      <span className="tm-chip-label">{m?.handle ?? mid.slice(0, 8)}</span>
                      <button
                        className="tm-chip-x"
                        onClick={() => removeAssignee(mid)}
                        title="Unassign"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  );
                })}
                <div style={{ position: "relative" }}>
                  <button
                    className="tm-add-chip"
                    onClick={() => setAssignPickerOpen((o) => !o)}
                  >
                    <Plus size={11} /> add
                  </button>
                  {assignPickerOpen && (
                    <div className="tm-popover">
                      <input
                        autoFocus
                        placeholder="Filter…"
                        value={assignFilter}
                        onChange={(e) => setAssignFilter(e.target.value)}
                        className="tm-popover-input"
                      />
                      <ul className="tm-popover-list">
                        {filteredMembers.slice(0, 20).map((m) => (
                          <li key={m.memberId}>
                            <button
                              className="tm-popover-item"
                              onClick={() => addAssignee(m.memberId)}
                            >
                              <Avatar
                                name={m.name}
                                color={m.color}
                                agent={m.kind === "agent"}
                                size="sm"
                              />
                              <span>{m.name}</span>
                              <span className="mono text-[11px] text-[var(--color-muted)]">
                                @{m.handle}
                              </span>
                            </button>
                          </li>
                        ))}
                        {filteredMembers.length === 0 && (
                          <li className="tm-popover-empty">no matches</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="tm-rail-field">
              <div className="tm-rail-label">Labels</div>
              <div className="tm-av-row">
                {(t.labels ?? []).map((l) => (
                  <span key={l} className="kc-label">
                    {l}
                    <button className="tm-chip-x" onClick={() => removeLabel(l)}>
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <input
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addLabel();
                  }}
                  placeholder="+ label"
                  className="tm-label-input"
                />
              </div>
            </div>

            <div className="tm-rail-field">
              <div className="tm-rail-label">Due date</div>
              <input
                type="date"
                value={t.dueAt ? t.dueAt.slice(0, 10) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  patchTask({ dueAt: v ? new Date(v).toISOString() : null } as Partial<Task>);
                }}
                className="tm-date"
              />
            </div>

            <div className="tm-rail-field">
              <div className="tm-rail-label">Progress</div>
              <div className="tm-rail-progress">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={t.progress}
                  onChange={(e) => patchTask({ progress: Number(e.target.value) })}
                  className="tm-slider"
                />
                <span className="tm-rail-progress-num">{t.progress}%</span>
              </div>
            </div>

            <div className="tm-rail-field">
              <div className="tm-rail-label">Linked tasks</div>
              {detail.links.length === 0 && !linkDraft && (
                <div className="tm-rail-empty">No links yet.</div>
              )}
              {detail.links.length > 0 && (
                <ul className="tm-link-list">
                  {detail.links.map((l) => (
                    <li key={l.id} className="tm-link-item">
                      <span className="mono text-[11px] text-[var(--color-muted)]">{l.kind}</span>
                      <span className="tm-link-title">
                        {l.linked?.title ?? l.linkedTaskId}
                      </span>
                      <button className="tm-chip-x" onClick={() => removeLink(l.id)}>
                        <X size={10} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="tm-link-add">
                <input
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  placeholder="task_id to link"
                  className="tm-sub-input"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addLink();
                  }}
                />
                <button className="btn xs" onClick={addLink} disabled={!linkDraft.trim()}>
                  Link
                </button>
              </div>
            </div>

            <div className="tm-rail-field tm-rail-meta">
              <div className="tm-rail-label">Created</div>
              <div className="mono text-[11px] text-[var(--color-muted)]">
                {new Date(t.createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function formatActivity(a: TaskDetail["activity"][number]): string {
  switch (a.kind) {
    case "created":
      return "created";
    case "status_changed":
      return `status → ${String((a.payload as { to?: string }).to ?? "?")}`;
    case "renamed":
      return "renamed";
    case "progress_changed":
      return `progress → ${String((a.payload as { to?: number }).to ?? "?")}%`;
    case "assigned":
      return "assigned someone";
    case "unassigned":
      return "unassigned someone";
    case "labels_changed":
      return "updated labels";
    case "link_added":
      return "added a link";
    case "link_removed":
      return "removed a link";
    case "comment":
      return "commented";
    default:
      return a.kind;
  }
}

// Suppress unused-type warnings
void ({} as TaskCommentRow);
