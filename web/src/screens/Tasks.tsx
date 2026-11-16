// SPDX-License-Identifier: AGPL-3.0-only
// Tasks: a shared checklist per chat.
import { useEffect, useState, type FormEvent } from "react";
import { api, type Task } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { AgentAv, Empty, Icon, UserAv } from "../ui/ui.tsx";
import { ChatAvatar, TaskBox, chatTitle } from "./Chats.tsx";

const SECTIONS: [string, Task["status"][]][] = [
  ["Needs you", ["needs_you"]],
  ["In progress", ["working", "checking"]],
  ["To do", ["todo"]],
  ["Done", ["done"]],
];

export function TasksScreen({ chatId }: { chatId?: string }) {
  const { chats, agent, go, fail, user } = useStore();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  useEffect(() => {
    api
      .get("/api/tasks")
      .then((r) => setTasks(r.tasks))
      .catch(fail);
  }, [fail]);
  useBus((e) => {
    if (e.type === "task") setTasks((l) => (l.some((t) => t.id === e.task.id) ? l.map((t) => (t.id === e.task.id ? e.task : t)) : [...l, e.task]));
  });
  useEffect(() => {
    if (!chatId && chats.length) {
      const withTasks = chats.find((c) => tasks.some((t) => t.chatId === c.id));
      go(`/tasks/${(withTasks ?? chats[0]).id}`, true);
    }
  }, [chatId, chats, tasks, go]);

  const c = chats.find((x) => x.id === chatId);
  const mine = tasks.filter((t) => t.chatId === chatId);
  const done = mine.filter((t) => t.status === "done").length;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !chatId) return;
    const [type, id] = assignee ? assignee.split(":") : ["", ""];
    try {
      await api.post("/api/tasks", { chatId, title, assigneeType: type, assigneeId: id });
      setTitle("");
    } catch (x) {
      fail(x);
    }
  };
  const setStatus = (t: Task, status: Task["status"]) => api.patch(`/api/tasks/${t.id}`, { status }).catch(fail);

  return (
    <div className="main">
      <div className="list">
        <div className="list-top">
          <h2>Tasks</h2>
        </div>
        <div className="scroll">
          {chats.map((ch) => {
            const ts = tasks.filter((t) => t.chatId === ch.id);
            const open = ts.filter((t) => t.status !== "done").length;
            return (
              <div key={ch.id} className={"row-chat" + (ch.id === chatId ? " on" : "")} onClick={() => go(`/tasks/${ch.id}`)}>
                <ChatAvatar c={ch} />
                <div className="mid">
                  <div className="t">
                    <b>{chatTitle(ch, agent)}</b>
                  </div>
                  <div className="p">{ts.length ? `${open} open · ${ts.length - open} done` : "No tasks"}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="convo pane">
        {!c ? (
          <div className="big-empty" style={{ height: "100%" }}>
            <Empty icon="board">Pick a chat to see its tasks.</Empty>
          </div>
        ) : (
          <div className="page">
            <div className="row">
              <h2 className="h2" style={{ cursor: "pointer" }} onClick={() => go(`/chats/${c.id}`)}>
                {chatTitle(c, agent)}
              </h2>
            </div>
            <div className="meter" style={{ marginTop: 16 }}>
              <i style={{ width: `${mine.length ? (done / mine.length) * 100 : 0}%`, background: "var(--done)" }} />
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              {done} of {mine.length} done
            </div>
            <form onSubmit={add} className="row" style={{ marginTop: 18, gap: 8 }}>
              <input className="input sm grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="New task" />
              <select className="input sm" style={{ width: 160 }} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Who does it">
                <option value="">Anyone</option>
                {c.members.map((m) => (
                  <option key={m.type + m.id} value={`${m.type}:${m.id}`}>
                    {m.type === "agent" ? agent(m.id)?.name : user(m.id)?.name}
                  </option>
                ))}
              </select>
              <button className="btn primary sm" disabled={!title.trim()}>
                <Icon n="plus" size="sm" />
                Add
              </button>
            </form>
            {mine.length === 0 && <Empty icon="check">No tasks here yet. Agents add them when they post a plan.</Empty>}
            {SECTIONS.map(([label, statuses]) => {
              const list = mine.filter((t) => statuses.includes(t.status));
              if (!list.length) return null;
              return (
                <div key={label}>
                  <div className="sect">{label}</div>
                  <ul className="todo group" style={{ padding: "6px 16px" }}>
                    {list.map((t, i) => (
                      <li key={t.id} style={{ padding: "8px 0", borderTop: i ? "1px solid var(--line)" : undefined }}>
                        <TaskBox t={t} onToggle={() => setStatus(t, t.status === "done" ? "todo" : "done")} />
                        <span className={t.status === "done" ? "done-t" : ""}>{t.title}</span>
                        <span className="who">
                          {t.status === "needs_you" && <span className="status waiting">Needs you</span>}
                          {t.status === "checking" && <span className="status working">Checking</span>}
                          <select
                            className="input sm"
                            style={{ height: 30, width: 120, fontSize: 12.5, paddingRight: 28, backgroundPosition: "right 8px center" }}
                            value={t.status}
                            aria-label="Status"
                            onChange={(e) => setStatus(t, e.target.value as Task["status"])}
                          >
                            <option value="todo">To do</option>
                            <option value="working">In progress</option>
                            <option value="checking">Checking</option>
                            <option value="needs_you">Needs you</option>
                            <option value="done">Done</option>
                          </select>
                          {t.assigneeType === "agent" && <AgentAv a={agent(t.assigneeId)} size={28} dot={false} />}
                          {t.assigneeType === "user" && <UserAv u={user(t.assigneeId)} size={28} />}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
