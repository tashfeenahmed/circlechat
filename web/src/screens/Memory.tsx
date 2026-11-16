// SPDX-License-Identifier: AGPL-3.0-only
// Memory: what the team, each chat and each agent remembers. Edit, forget, bring back.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Memory } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { AgentAv, Empty, Icon, Toggle, UserAv, shortWhen, hhmm } from "../ui/ui.tsx";
import { ChatAvatar, chatTitle } from "./Chats.tsx";

export function MemoryScreen({ filter, scopeId }: { filter: string; scopeId: string }) {
  const { chats, agents, agent, go, fail, isAdmin, toast } = useStore();
  const [mems, setMems] = useState<Memory[]>([]);
  const [paused, setPaused] = useState(false);
  const [text, setText] = useState("");
  useEffect(() => {
    api
      .get("/api/memories")
      .then((r) => {
        setMems(r.memories);
        setPaused(r.paused);
      })
      .catch(fail);
  }, [fail]);
  useBus((e) => {
    if (e.type === "memory") setMems((l) => (l.some((m) => m.id === e.memory.id) ? l.map((m) => (m.id === e.memory.id ? e.memory : m)) : [e.memory, ...l]));
  });

  const scope = filter === "chat" || filter === "agent" ? filter : "team";
  const shown = mems.filter((m) => m.scope === scope && (scope === "team" || m.scopeId === scopeId));
  const live = (pred: (m: Memory) => boolean) => mems.filter((m) => pred(m) && !m.forgottenAt).length;
  const c = scope === "chat" ? chats.find((x) => x.id === scopeId) : undefined;
  const a = scope === "agent" ? agent(scopeId) : undefined;
  const title = scope === "team" ? "Everyone remembers" : c ? `${chatTitle(c, agent)} remembers` : a ? `${a.name}'s notes` : "Memory";
  const sub = scope === "team" ? "Every agent uses these. Click one to change it." : c ? "Only agents working in this chat use these." : a ? `Only ${a.name} uses these.` : "";

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await api.post("/api/memories", { scope, scopeId: scope === "team" ? "" : scopeId, text });
      setText("");
    } catch (x) {
      fail(x);
    }
  };
  const setPause = async (v: boolean) => {
    try {
      const r = await api.put("/api/memories/paused", { paused: v });
      setPaused(r.paused);
      toast(r.paused ? "Memory paused. Agents won't save anything new." : "Memory is on");
    } catch (x) {
      fail(x);
    }
  };

  const navRow = (key: string, on: boolean, icon: ReactNode, name: string, p: string, to: string) => (
    <div key={key} className={"row-chat" + (on ? " on" : "")} onClick={() => go(to)}>
      {icon}
      <div className="mid">
        <div className="t">
          <b>{name}</b>
        </div>
        <div className="p">{p}</div>
      </div>
    </div>
  );

  return (
    <div className="main">
      <div className="list">
        <div className="list-top">
          <h2>Memory</h2>
        </div>
        <div className="scroll">
          {navRow(
            "team",
            scope === "team",
            <span style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--accent-soft)", display: "grid", placeItems: "center", color: "var(--accent)", flex: "none" }}>
              <Icon n="users" />
            </span>,
            "Everyone",
            things(live((m) => m.scope === "team")),
            "/memory?f=team",
          )}
          <div className="setnav-h">Chats</div>
          {chats
            .filter((ch) => ch.kind !== "agents")
            .map((ch) =>
              navRow(ch.id, scope === "chat" && scopeId === ch.id, <ChatAvatar c={ch} />, chatTitle(ch, agent), `${things(live((m) => m.scope === "chat" && m.scopeId === ch.id))} · stays in this chat`, `/memory?f=chat&id=${ch.id}`),
            )}
          <div className="setnav-h">Agents' own notes</div>
          {agents.map((ag) =>
            navRow(ag.id, scope === "agent" && scopeId === ag.id, <AgentAv a={ag} />, `${ag.name}'s notes`, `${things(live((m) => m.scope === "agent" && m.scopeId === ag.id))} · only ${ag.name}`, `/memory?f=agent&id=${ag.id}`),
          )}
        </div>
        <div style={{ margin: "8px 16px 16px", padding: 14, borderRadius: 16, background: "var(--bg)" }} className="row small">
          <Icon n="eyeoff" />
          <span className="grow">
            Pause memory
            {!isAdmin && <div className="muted">Admins only</div>}
          </span>
          <Toggle on={paused} onChange={setPause} disabled={!isAdmin} label="Pause memory" />
        </div>
      </div>
      <div className="convo pane">
        <div className="page">
          <h2 className="h2">{title}</h2>
          <p className="muted" style={{ marginTop: 4 }}>
            {sub}
          </p>
          {paused && (
            <div className="pill-c warn" style={{ margin: "14px 0 0" }}>
              <Icon n="eyeoff" size="sm" className="ic-sm" />
              Memory is paused. Agents can still read, but nothing new is saved.
            </div>
          )}
          <form onSubmit={add} className="row" style={{ gap: 8, marginTop: 20 }}>
            <input className="input sm grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add something to remember" aria-label="New memory" />
            <button className="btn primary sm" disabled={!text.trim()}>
              <Icon n="plus" size="sm" />
              Remember
            </button>
          </form>
          <div className="col" style={{ gap: 10, marginTop: 18 }}>
            {shown.length === 0 && <Empty icon="memory">Nothing remembered here yet.</Empty>}
            {shown.map((m) => (
              <MemoryCard key={m.id} m={m} />
            ))}
          </div>
          <div className="row small muted" style={{ gap: 8, marginTop: 22 }}>
            <Icon n="lock" size="sm" />
            Passwords and keys are never saved here. Use a connection or the vault instead.
          </div>
        </div>
      </div>
    </div>
  );
}

const things = (n: number) => `${n} ${n === 1 ? "thing" : "things"}`;

function MemoryCard({ m }: { m: Memory }) {
  const { agent, user, me, fail, toast } = useStore();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(m.text);
  useEffect(() => setText(m.text), [m.text]);
  const forgotten = !!m.forgottenAt;
  const save = async () => {
    setEdit(false);
    if (text.trim() === m.text) return;
    try {
      await api.patch(`/api/memories/${m.id}`, { text });
      toast("Saved");
    } catch (x) {
      fail(x);
    }
  };
  const patch = (b: object) => api.patch(`/api/memories/${m.id}`, b).catch(fail);
  const who = m.byType === "agent" ? agent(m.byId) : undefined;
  const whoName = who ? who.name : m.byId === me.id ? "You" : (user(m.byId)?.name ?? "Someone");
  const isNew = Date.now() - m.createdAt < 3600_000;
  return (
    <div className="group" style={{ padding: "14px 16px", opacity: forgotten ? 0.55 : 1 }}>
      {edit ? (
        <textarea
          className="input"
          style={{ minHeight: 70 }}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") {
              setText(m.text);
              setEdit(false);
            }
          }}
        />
      ) : (
        <div
          style={{ fontSize: 16, fontWeight: 500, textDecoration: forgotten ? "line-through" : undefined, cursor: forgotten ? "default" : "text" }}
          onClick={() => !forgotten && setEdit(true)}
          title={forgotten ? undefined : "Click to edit"}
        >
          {m.text}
        </div>
      )}
      <div className="row small muted" style={{ gap: 8, marginTop: 8 }}>
        {forgotten ? (
          <>
            Forgotten by {m.forgottenBy === me.id ? "you" : (user(m.forgottenBy ?? "")?.name ?? "someone")} · {shortWhen(m.forgottenAt!)}
            <span className="linkish" style={{ marginLeft: "auto" }} onClick={() => patch({ restore: true })}>
              Bring back
            </span>
          </>
        ) : (
          <>
            {who ? <AgentAv a={who} size={26} dot={false} /> : <UserAv u={user(m.byId)} size={26} />}
            <span>
              {whoName} {m.byType === "agent" ? "learned this" : "added this"} {shortWhen(m.createdAt) === hhmm(m.createdAt) ? `today at ${hhmm(m.createdAt)}` : shortWhen(m.createdAt)}
              {m.source ? ` · ${m.source}` : ""}
            </span>
            {isNew && (
              <span className="tag-agent" style={{ background: "var(--accent-soft)", color: "var(--accent)", marginLeft: "auto" }}>
                New
              </span>
            )}
            <span className="linkish" style={{ marginLeft: isNew ? 8 : "auto", color: "var(--ink-3)" }} onClick={() => patch({ forget: true })}>
              Forget
            </span>
          </>
        )}
      </div>
    </div>
  );
}
