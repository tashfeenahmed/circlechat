// SPDX-License-Identifier: AGPL-3.0-only
// Search across agents, chats, messages and tasks.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Agent, type Chat, type Task } from "../api.ts";
import { useStore } from "../store.tsx";
import { AgentAv, Empty, Filters, Icon, UserAv, shortWhen } from "../ui/ui.tsx";
import { ChatAvatar, TaskBox, chatTitle } from "./Chats.tsx";

interface Results {
  agents: Agent[];
  chats: Chat[];
  messages: { id: string; chatId: string; authorType: string; authorId: string; body: string; ts: number }[];
  tasks: Task[];
}

function hl(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  const start = Math.max(0, i - 60);
  return (
    <>
      {start > 0 ? "…" : ""}
      {text.slice(start, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length, i + q.length + 160)}
    </>
  );
}

export function SearchScreen({ q: initial }: { q: string }) {
  const { go, agent, user, chat, me } = useStore();
  const [q, setQ] = useState(initial);
  const [r, setR] = useState<Results | null>(null);
  const [tab, setTab] = useState<"all" | "agents" | "chats" | "messages" | "tasks">("all");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  // only the newest search may show its results: a slow answer to an older query is dropped
  const latest = useRef(0);
  useEffect(() => {
    const n = ++latest.current;
    const t = setTimeout(() => {
      if (q.trim().length < 2) return setR(null);
      api
        .get(`/api/search?q=${encodeURIComponent(q.trim())}`)
        .then((res) => n === latest.current && setR(res))
        .catch(() => n === latest.current && setR(null));
      history.replaceState(null, "", `/search?q=${encodeURIComponent(q)}`);
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  const show = (k: typeof tab) => tab === "all" || tab === k;
  const none = r && !r.agents.length && !r.chats.length && !r.messages.length && !r.tasks.length;
  return (
    <div className="main solo">
      <div className="convo pane" style={{ background: "var(--bg)" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "34px 24px", width: "100%" }}>
          <div className="input" style={{ height: 56, fontSize: 17, background: "var(--surface)", borderColor: "var(--accent)", boxShadow: "0 0 0 4px var(--accent-soft)" }}>
            <Icon n="search" style={{ color: "var(--ink-3)" }} />
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && history.back()}
              placeholder="Search agents, chats, messages, tasks"
              style={{ border: 0, outline: "none", background: "transparent", flex: 1, fontSize: 17 }}
              aria-label="Search"
            />
            <span className="muted small">esc</span>
          </div>
          <Filters
            style={{ padding: "14px 0 0" }}
            value={tab}
            onChange={setTab}
            options={[
              ["all", "All"],
              ["agents", "Agents"],
              ["chats", "Chats"],
              ["messages", "Messages"],
              ["tasks", "Tasks"],
            ]}
          />
          {!r && <Empty icon="search">Type at least 2 letters.</Empty>}
          {none && <Empty icon="search">Nothing found for "{q}".</Empty>}
          {r && show("agents") && r.agents.length > 0 && (
            <>
              <div className="sect">Agents</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {r.agents.map((a) => (
                  <div key={a.id} className="group row" style={{ padding: "12px 14px", gap: 10, cursor: "pointer" }} onClick={() => go(`/agents/${a.id}`)}>
                    <AgentAv a={agent(a.id) ?? a} size={40} />
                    <div style={{ minWidth: 0 }}>
                      <b style={{ fontWeight: 600 }}>{hl(a.name, q)}</b>
                      <div className="small muted">{a.roleTitle || `@${a.handle}`}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {r && show("chats") && r.chats.length > 0 && (
            <>
              <div className="sect">Chats</div>
              <div className="group">
                {r.chats.map((c) => (
                  <div key={c.id} className="row-chat" style={{ margin: 0 }} onClick={() => go(`/chats/${c.id}`)}>
                    <ChatAvatar c={c} />
                    <div className="mid">
                      <div className="t">
                        <b>{hl(chatTitle(c, agent), q)}</b>
                        <time>{shortWhen(c.last?.ts ?? c.createdAt)}</time>
                      </div>
                      <div className="p">{c.members.length} members</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {r && show("messages") && r.messages.length > 0 && (
            <>
              <div className="sect">Messages</div>
              <div className="group">
                {r.messages.map((m) => {
                  const c = chat(m.chatId);
                  const a = m.authorType === "agent" ? agent(m.authorId) : undefined;
                  const who = a ? a.name : m.authorType === "user" ? (m.authorId === me.id ? "You" : (user(m.authorId)?.name ?? "someone")) : "CircleChat";
                  return (
                    <div key={m.id} className="it" style={{ alignItems: "flex-start", cursor: "pointer" }} onClick={() => go(`/chats/${m.chatId}`)}>
                      {a ? (
                        <AgentAv a={a} size={38} dot={false} />
                      ) : m.authorType === "user" ? (
                        <UserAv u={user(m.authorId)} size={38} />
                      ) : (
                        <span className="ic" style={{ width: 32, height: 32, borderRadius: 10, background: "var(--bg)", display: "grid", placeItems: "center", flex: "none" }}>
                          <Icon n="flag" size="sm" />
                        </span>
                      )}
                      <div className="grow">
                        <div className="small muted">
                          <b style={{ color: "var(--ink)" }}>{who}</b> in {c ? chatTitle(c, agent) : "a chat"} · {shortWhen(m.ts)}
                        </div>
                        <div>{hl(m.body, q)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {r && show("tasks") && r.tasks.length > 0 && (
            <>
              <div className="sect">Tasks</div>
              <ul className="todo group" style={{ padding: "6px 16px" }}>
                {r.tasks.map((t, i) => {
                  const c = chat(t.chatId);
                  return (
                    <li key={t.id} style={{ padding: "8px 0", borderTop: i ? "1px solid var(--line)" : undefined, cursor: "pointer" }} onClick={() => go(`/tasks/${t.chatId}`)}>
                      <TaskBox t={t} />
                      <span className={t.status === "done" ? "done-t" : ""}>{hl(t.title, q)}</span>
                      <span className="who small muted">{c ? chatTitle(c, agent) : ""}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
