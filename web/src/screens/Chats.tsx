// SPDX-License-Identifier: AGPL-3.0-only
// Chat list, conversation, composer with @mentions, group info drawer, new chat.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKE, type ReactNode } from "react";
import { api, type Agent, type Approval, type Chat, type Member, type Message, type Task } from "../api.ts";
import { useBus, useStore, isPhone } from "../store.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import {
  AgentAv,
  Cluster,
  Empty,
  Filters,
  Icon,
  MemberAv,
  Modal,
  StatusPill,
  UserAv,
  dayLabel,
  hhmm,
  shortWhen,
  statusLabel,
  tintVars,
  vis,
  WorkingMark,
  withMentions,
} from "../ui/ui.tsx";

// ================================================================ list column
type ChatFilter = "all" | "groups" | "agents" | "people";

export function chatTitle(c: Chat, agent: (id: string) => Agent | undefined): string {
  if (c.kind === "dm") {
    const a = c.members.find((m) => m.type === "agent");
    return (a && agent(a.id)?.name) || c.name;
  }
  return c.name;
}

export function ChatAvatar({ c, size = 48 }: { c: Chat; size?: number }) {
  const { agent } = useStore();
  if (c.kind === "dm") {
    const m = c.members.find((x) => x.type === "agent");
    if (m) return <AgentAv a={agent(m.id)} size={size} />;
  }
  return <Cluster members={c.members} size={size} />;
}

/** Markdown to plain text for one-line previews. */
function plainMd(s: string): string {
  return s
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, " ")
    .replace(/\|/g, " ");
}

export function ChatList({ active }: { active?: string }) {
  const { chats, agent, user, me, go } = useStore();
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<"" | "group" | "dm">("");
  const shown = chats.filter((c) => {
    const hasAgent = c.members.some((m) => m.type === "agent");
    if (filter === "groups") return c.kind === "group";
    if (filter === "agents") return c.kind === "dm" || c.kind === "agents";
    if (filter === "people") return !hasAgent;
    return true;
  });
  const preview = (c: Chat): ReactNode => {
    const m = c.last;
    if (!m) return c.kind === "agents" ? "Agents only" : "No messages yet";
    let who = "";
    if (m.authorType === "user") who = m.authorId === me.id ? "You" : (user(m.authorId)?.name ?? "");
    if (m.authorType === "agent" && c.kind !== "dm") who = agent(m.authorId)?.name ?? "";
    const text =
      m.kind === "plan" ? `Plan: ${m.body}` : m.kind === "memory" ? `Saved to memory: ${m.body}` : m.kind === "approval" ? m.body : (m.authorType === "agent" ? plainMd(m.body) : m.body).replace(/\s+/g, " ");
    return who ? `${who}: ${text}` : text;
  };
  return (
    <div className="list">
      <div className="list-top">
        <h2>
          Chats
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="btn icon soft" aria-label="Message an agent" title="Message an agent" onClick={() => setMenu("dm")}>
              <Icon n="chat" />
            </button>
            <button className="btn icon soft" aria-label="New chat" title="New chat" onClick={() => setMenu("group")}>
              <Icon n="plus" />
            </button>
          </span>
        </h2>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            go(`/search?q=${encodeURIComponent(q)}`);
          }}
        >
          <Icon n="search" size="sm" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search" />
          <kbd>⌘K</kbd>
        </form>
      </div>
      <Filters
        value={filter}
        onChange={setFilter}
        options={[
          ["all", "All"],
          ["groups", "Groups"],
          ["agents", "Agents"],
          ["people", "People"],
        ]}
      />
      <div className="scroll">
        {shown.length === 0 && (
          <div className="small muted" style={{ padding: "20px 24px" }}>
            {chats.length === 0 ? "No chats yet. Start one with the + button." : "Nothing here."}
          </div>
        )}
        {shown.map((c) => (
          <div key={c.id} className={"row-chat" + (c.id === active ? " on" : "")} onClick={() => go(`/chats/${c.id}`)}>
            <ChatAvatar c={c} />
            <div className="mid">
              <div className="t">
                <b>{chatTitle(c, agent)}</b>
                <time>{shortWhen(c.last?.ts ?? c.createdAt)}</time>
              </div>
              <div className="b">
                <span className="p">{preview(c)}</span>
                {!!c.unread && c.id !== active && c.members.some((m) => m.type === "user" && m.id === me.id) && <span className={"unread" + (c.last?.kind === "approval" ? " ask" : "")}>{c.unread}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {menu === "group" && <NewChatModal onClose={() => setMenu("")} />}
      {menu === "dm" && <MessageAgentModal onClose={() => setMenu("")} />}
    </div>
  );
}

// ================================================================ screen
export function ChatsScreen({ chatId, info }: { chatId?: string; info?: boolean }) {
  const { chats, go } = useStore();
  useEffect(() => {
    if (!chatId && chats.length && !isPhone()) go(`/chats/${chats[0].id}`, true);
  }, [chatId, chats, go]);
  return (
    <div className={"main" + (info && chatId ? " drawer" : "")}>
      <ChatList active={chatId} />
      {chatId ? (
        <Conversation key={chatId} chatId={chatId} info={!!info} />
      ) : (
        <div className="big-empty">
          <Empty icon="chat">Pick a chat, or start a new one.</Empty>
        </div>
      )}
    </div>
  );
}

// ================================================================ first steps
const IDEAS = [
  "What can you do for our team?",
  "Find the 3 best tools for running a small team and compare them",
  "Plan a product launch for next Tuesday as a checklist",
  "Write a short, friendly welcome email for new customers",
];
/** Shown until a person has written in the chat: one tap starts a real conversation. */
function StartHere({ chatId, agents }: { chatId: string; agents: Agent[] }) {
  const { go, fail } = useStore();
  const [busy, setBusy] = useState(false);
  const lead = agents[0];
  const ask = async (idea: string) => {
    if (busy) return;
    setBusy(true);
    try {
      // in a group with several agents, ask the first one by name
      const body = agents.length > 1 ? `@${lead.handle} ${idea}` : idea;
      await api.post(`/api/chats/${chatId}/messages`, { body });
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  return (
    <div className="start-here" style={tintVars(lead)}>
      <div className="start-head">
        <AgentAv a={lead} size={56} dot={false} />
        <div>
          <div className="start-title">Try asking {lead.name}</div>
          <div className="small muted">Tap one to send it, or write your own below.</div>
        </div>
      </div>
      <div className="start-ideas">
        {IDEAS.map((i) => (
          <button key={i} className="start-idea" disabled={busy} onClick={() => ask(i)}>
            {i}
            <Icon n="send" size="sm" />
          </button>
        ))}
      </div>
      <div className="start-more">
        <button className="btn sm ghost" onClick={() => go("/agents/new")}>
          <Icon n="plus" size="sm" /> Add another agent
        </button>
        <button className="btn sm ghost" onClick={() => go("/people")}>
          <Icon n="users" size="sm" /> Invite a teammate
        </button>
      </div>
    </div>
  );
}

// ================================================================ conversation
function Conversation({ chatId, info }: { chatId: string; info: boolean }) {
  const { agent, user, me, go, fail, reloadChats } = useStore();
  const [chat, setChat] = useState<Chat | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [more, setMore] = useState(false);
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const [typing, setTyping] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const readTimer = useRef<number | undefined>(undefined);

  const markRead = useCallback(() => {
    clearTimeout(readTimer.current);
    readTimer.current = window.setTimeout(() => {
      api
        .post(`/api/chats/${chatId}/read`)
        .then(() => reloadChats())
        .catch(() => {});
    }, 300);
  }, [chatId, reloadChats]);

  const load = useCallback(async () => {
    try {
      const [c, m, ap] = await Promise.all([api.get(`/api/chats/${chatId}`), api.get(`/api/chats/${chatId}/messages?limit=100`), api.get("/api/approvals")]);
      setChat(c.chat);
      setMsgs(m.messages);
      setMore(m.messages.length >= 100);
      setApprovals(Object.fromEntries((ap.approvals as Approval[]).map((a) => [a.id, a])));
      stick.current = true;
      markRead();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [chatId, markRead]);
  useEffect(() => {
    load();
  }, [load]);

  useBus((e) => {
    if (e.type === "hello") load();
    if (e.type === "message" && e.chatId === chatId) {
      setMsgs((l) => (l.some((x) => x.id === e.message.id) ? l : [...l, e.message]));
      if (e.message.authorType === "agent")
        setTyping((t) => {
          const n = new Set(t);
          n.delete(e.message.authorId);
          return n;
        });
      markRead();
    }
    if (e.type === "message_updated" && e.chatId === chatId) setMsgs((l) => l.map((x) => (x.id === e.message.id ? e.message : x)));
    if (e.type === "typing" && e.chatId === chatId)
      setTyping((t) => {
        const n = new Set(t);
        if (e.on) n.add(e.agentId);
        else n.delete(e.agentId);
        return n;
      });
    if (e.type === "approval") setApprovals((m) => ({ ...m, [e.approval.id]: e.approval }));
    if (e.type === "chat" && e.chat.id === chatId) setChat((c) => ({ ...(c ?? e.chat), ...e.chat }));
  });

  // stay pinned to the bottom unless the reader scrolled up
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, typing]);
  const onScroll = () => {
    const el = threadRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const loadEarlier = async () => {
    if (!msgs.length) return;
    try {
      const el = threadRef.current;
      const h = el?.scrollHeight ?? 0;
      const r = await api.get(`/api/chats/${chatId}/messages?limit=100&before=${msgs[0].ts}`);
      stick.current = false;
      setMsgs((l) => [...r.messages, ...l]);
      setMore(r.messages.length >= 100);
      requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - h));
    } catch (e) {
      fail(e);
    }
  };

  if (err)
    return (
      <div className="big-empty">
        <Empty icon="alert">{err}</Empty>
      </div>
    );
  if (!chat) return <div className="convo" />;

  const agentsHere = chat.members.filter((m) => m.type === "agent").map((m) => agent(m.id)).filter(Boolean) as Agent[];
  const people = chat.members.filter((m) => m.type === "user");
  const dmAgent = chat.kind === "dm" ? agentsHere[0] : undefined;
  const title = chatTitle(chat, agent);
  const memberNames = [
    ...[...people].sort((x) => (x.id === me.id ? -1 : 1)).map((m) => (m.id === me.id ? "You" : (user(m.id)?.name ?? "someone"))),
    ...agentsHere.map((a) => a.name),
  ].join(", ");

  return (
    <>
      <div className="convo">
        <div className="convo-head">
          {dmAgent ? <AgentAv a={dmAgent} size={44} onClick={() => go(`/agents/${dmAgent.id}`)} /> : <Cluster members={chat.members} size={44} />}
          <div style={{ cursor: "pointer", minWidth: 0 }} onClick={() => (dmAgent ? go(`/agents/${dmAgent.id}`) : go(`/chats/${chatId}?info=1`))}>
            <h3>{title}</h3>
            <div className="sub">
              {dmAgent
                ? `${dmAgent.roleTitle || "Agent"} · ${statusLabel(dmAgent.status).toLowerCase()}`
                : chat.kind === "agents"
                  ? "Agents only · you can read and join"
                  : memberNames}
            </div>
          </div>
          <div className="right">
            {dmAgent && (
              <button className="btn sm soft" style={{ alignSelf: "center" }} onClick={() => go(`/agents/${dmAgent.id}/watch`)}>
                <Icon n="monitor" size="sm" />
                Watch
              </button>
            )}
            <button className="btn icon ghost" aria-label="Tasks" title="Tasks" onClick={() => go(`/tasks/${chatId}`)}>
              <Icon n="board" />
            </button>
            <button className="btn icon ghost" aria-label="Memory" title="Memory" onClick={() => go(`/memory?f=chat&id=${chatId}`)}>
              <Icon n="memory" />
            </button>
            <button className="btn icon ghost" aria-label="Info" title="Info" onClick={() => go(info ? `/chats/${chatId}` : `/chats/${chatId}?info=1`)}>
              <Icon n="more" />
            </button>
          </div>
        </div>
        {agentsHere.length > 0 && !dmAgent && <NowStrip agents={agentsHere} />}
        {dmAgent && ["working", "waiting", "blocked"].includes(vis(dmAgent.status)) && <NowStrip agents={[dmAgent]} />}
        <div className="thread" ref={threadRef} onScroll={onScroll}>
          {more && (
            <button className="btn sm ghost" style={{ alignSelf: "center" }} onClick={loadEarlier}>
              Load earlier messages
            </button>
          )}
          {msgs.length === 0 && (
            <div className="when" style={{ marginTop: 40 }}>
              {dmAgent ? `Say hi to ${dmAgent.name}.` : agentsHere.length === 1 ? `Say hi to ${agentsHere[0].name}.` : agentsHere.length ? "Mention an agent with @ to get it started, or @all to ask everyone." : "No messages yet."}
            </div>
          )}
          <Thread msgs={msgs} chat={chat} approvals={approvals} />
          {chat.kind !== "agents" && agentsHere.length > 0 && typing.size === 0 && !msgs.some((m) => m.authorType === "user") && (
            <StartHere chatId={chat.id} agents={agentsHere} />
          )}
          {[...typing].map((id) => {
            const a = agent(id);
            return (
              <div key={id} className="m gap" style={tintVars(a)}>
                <AgentAv a={a} size={40} dot={false} />
                <div className="stackm">
                  <div className="typing-b" aria-label={`${a?.name ?? "Agent"} is typing`}>
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <Composer
          chat={chat}
          agents={agentsHere}
          onOpenInfo={() => go(`/chats/${chatId}?info=1`)}
          placeholder={
            chat.kind === "agents"
              ? "Step in and reply…"
              : dmAgent
                ? `Message ${dmAgent.name}…`
                : agentsHere.length === 1
                  ? `Message ${agentsHere[0].name}…`
                  : agentsHere.length > 1
                    ? "Message the group. @name asks one agent, @all asks everyone…"
                    : `Message ${title}…`
          }
        />
      </div>
      {info && <GroupInfo chat={chat} onClose={() => go(`/chats/${chatId}`)} />}
    </>
  );
}

function NowStrip({ agents: raw }: { agents: Agent[] }) {
  const { go, pending } = useStore();
  // a gateway approval doesn't change the agent's state, so look at what's pending too
  const agents = raw.map((a) =>
    pending.some((p) => p.agentId === a.id) && a.status.state !== "waiting_approval" ? { ...a, status: { ...a.status, state: "waiting_approval" as const } } : a,
  );
  const order = { working: 0, waiting: 1, blocked: 2, idle: 3, sleeping: 4 };
  const list = [...agents].sort((a, b) => order[vis(a.status)] - order[vis(b.status)]);
  return (
    <div className="now">
      <span className="muted">Now</span>
      {list.map((a) => {
        const v = vis(a.status);
        const detail =
          v === "working" ? a.status.detail || "working" : v === "waiting" ? "needs your OK" : v === "blocked" ? statusLabel(a.status).toLowerCase() : v === "idle" ? "ready" : statusLabel(a.status).toLowerCase();
        return (
          <span key={a.id} className="now-pill" onClick={() => go(v === "waiting" ? "/needs" : v === "working" ? `/agents/${a.id}/watch` : `/agents/${a.id}`)}>
            <AgentAv a={a} size={30} dot={false} />
            <b>{a.name}</b>
            <span className="detail" style={v === "blocked" ? { color: "var(--blocked)" } : v === "waiting" ? { color: "var(--waiting)" } : undefined}>
              {detail}
            </span>
            {v === "working" && <span className="go">Watch</span>}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- thread rendering
const CENTRED = new Set(["handoff", "memory", "system", "error", "trigger"]);

function Thread({ msgs, chat, approvals }: { msgs: Message[]; chat: Chat; approvals: Record<string, Approval> }) {
  const { me } = useStore();
  const out: ReactNode[] = [];
  const authorKey = (m: Message) => (m.kind === "approval" ? `ap:${approvals[m.meta.approvalId]?.agentId ?? ""}` : `${m.authorType}:${m.authorId}`);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    if (!prev || m.ts - prev.ts > 30 * 60_000 || new Date(m.ts).toDateString() !== new Date(prev.ts).toDateString())
      out.push(
        <div key={"w" + m.id} className="when">
          {dayLabel(m.ts)}
          {m.meta?.originChat && chat.kind === "agents" ? " · hand-off" : ""}
        </div>,
      );
    if (CENTRED.has(m.kind)) {
      out.push(<CentredNote key={m.id} m={m} />);
      continue;
    }
    const sameAsPrev = !!prev && !CENTRED.has(prev.kind) && authorKey(prev) === authorKey(m) && m.ts - prev.ts < 5 * 60_000;
    const sameAsNext = !!next && !CENTRED.has(next.kind) && authorKey(next) === authorKey(m) && next.ts - m.ts < 5 * 60_000;
    out.push(<Bubble key={m.id} m={m} first={!sameAsPrev} last={!sameAsNext} mine={m.authorType === "user" && m.authorId === me.id} dm={chat.kind === "dm"} approvals={approvals} />);
  }
  return <>{out}</>;
}

function Bubble({ m, first, last, mine, dm, approvals }: { m: Message; first: boolean; last: boolean; mine: boolean; dm: boolean; approvals: Record<string, Approval> }) {
  const { agent, user, go } = useStore();
  const ap = m.kind === "approval" ? approvals[m.meta.approvalId] : undefined;
  const agentId = m.authorType === "agent" ? m.authorId : ap?.agentId;
  const a = agentId ? agent(agentId) : undefined;
  const u = m.authorType === "user" ? user(m.authorId) : undefined;
  const name = a ? a.name : u ? u.name : "CircleChat";
  const showName = first && !mine && !(dm && a) && m.kind === "text";
  const av = a ? <AgentAv a={a} size={40} dot={false} onClick={() => go(`/agents/${a.id}`)} /> : u ? <UserAv u={u} size={40} /> : <span className="spacer" />;
  let content: ReactNode;
  if (m.kind === "plan") content = <PlanCard m={m} />;
  else if (m.kind === "approval") content = <ApprovalCard m={m} ap={ap} />;
  else
    content = (
      <div className={"bub" + (a ? " agent md-bub" : "") + (last ? " tail" : "")}>
        {a ? <Markdown text={m.body} /> : withMentions(m.body)}
      </div>
    );
  return (
    <div className={"m" + (mine ? " me" : "") + (first ? " gap" : "")} style={tintVars(a)}>
      {!mine && (last ? av : <span className="spacer" />)}
      <div className="stackm">
        {showName && <span className="name">{name}</span>}
        {content}
        {last && (
          <span className="meta">
            <time>{hhmm(m.ts)}</time>
            {m.meta?.handoff && " · handed over"}
          </span>
        )}
      </div>
    </div>
  );
}

function CentredNote({ m }: { m: Message }) {
  const { agent, go } = useStore();
  if (m.kind === "handoff") {
    const from = agent(m.meta.from);
    const to = agent(m.meta.to);
    return (
      <div className="pill-c click" title="Open the agents chat" onClick={() => m.meta.agentsChat && go(`/chats/${m.meta.agentsChat}`)}>
        {from && <AgentAv a={from} size={28} dot={false} />}
        <span style={{ maxWidth: 460, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.body}</span>
        <Icon n="arrow" size="sm" />
        {to && <AgentAv a={to} size={28} dot={false} />}
        {m.meta.hop ? <span className="muted small">hand-off {m.meta.hop} of 5</span> : null}
      </div>
    );
  }
  if (m.kind === "memory") {
    const by = agent(m.meta.by);
    return (
      <div className="pill-c click" onClick={() => go(`/memory?f=${m.meta.scope === "chat" ? "chat" : m.meta.scope === "agent" ? "agent" : "team"}${m.meta.scope === "agent" && m.meta.by ? `&id=${m.meta.by}` : m.meta.scope === "chat" ? `&id=${m.chatId}` : ""}`)}>
        {by ? <AgentAv a={by} size={28} dot={false} /> : <Icon n="memory" size="sm" className="ic-sm" />}
        Saved to memory: {m.body}
      </div>
    );
  }
  if (m.kind === "trigger")
    return (
      <div className="pill-c note">
        <Icon n="zap" size="sm" className="ic-sm" />
        {m.meta.replay ? "Replayed: " : ""}
        {m.body}
      </div>
    );
  if (m.kind === "error")
    return (
      <div className="pill-c err">
        <Icon n="alert" size="sm" className="ic-sm" />
        {m.body}
      </div>
    );
  const guard = m.authorType === "agent" ? agent(m.authorId) : undefined;
  return (
    <div className={"pill-c" + (m.meta.reason === "hop_limit" ? " warn" : " note")}>
      {guard ? <AgentAv a={guard} size={28} dot={false} /> : <Icon n="flag" size="sm" className="ic-sm" />}
      {m.body}
    </div>
  );
}

// ---------------------------------------------------------------- cards
export function TaskBox({ t, onToggle }: { t: Pick<Task, "status">; onToggle?: () => void }) {
  const cls = t.status === "done" ? "box ok" : t.status === "working" || t.status === "checking" ? "box run" : t.status === "needs_you" ? "box ask" : "box";
  return (
    <span
      className={cls + (onToggle ? " click" : "")}
      role={onToggle ? "checkbox" : undefined}
      aria-checked={t.status === "done"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
    >
      {t.status === "done" && <Icon n="check" />}
    </span>
  );
}

function PlanCard({ m }: { m: Message }) {
  const { agent, user, fail, go } = useStore();
  const steps: Task[] = m.meta.steps ?? [];
  const done = steps.filter((s) => s.status === "done").length;
  const toggle = (t: Task) => api.patch(`/api/tasks/${t.id}`, { status: t.status === "done" ? "todo" : "done" }).catch(fail);
  return (
    <div className="card">
      <div className="card-h">
        {m.body || "Plan"}
        <span className="muted">
          {done} of {steps.length} done
        </span>
      </div>
      <div className="card-b">
        <ul className="todo">
          {steps.map((t) => (
            <li key={t.id}>
              <TaskBox t={t} onToggle={() => toggle(t)} />
              <span className={t.status === "done" ? "done-t" : ""}>{t.title}</span>
              <span className="who">
                {t.status === "needs_you" && <Icon n="lock" size="sm" className="muted" />}
                {t.assigneeType === "agent" && <WorkingMark a={agent(t.assigneeId)} chatId={m.chatId} done={t.status === "done"} />}
                {t.assigneeType === "agent" && <AgentAv a={agent(t.assigneeId)} size={28} dot={false} />}
                {t.assigneeType === "user" && <UserAv u={user(t.assigneeId)} size={28} />}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="card-f">
        <button className="btn sm ghost" onClick={() => go(`/tasks/${m.chatId}`)}>
          Open tasks
          <Icon n="right" size="sm" />
        </button>
      </div>
    </div>
  );
}

export function argsSummary(args: any): string {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  const parts = Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.length > 60 ? v.slice(0, 60) + "…" : v) : JSON.stringify(v)}`);
  return parts.join(", ");
}

export function decisionText(ap: Pick<Approval, "state" | "decision" | "decidedBy">, userName: (id: string) => string): string {
  const by = ap.decidedBy && ap.decidedBy !== "system" ? userName(ap.decidedBy) : "";
  if (ap.state === "approved") return `${ap.decision === "allow_always" ? "Always allowed" : "Approved once"}${by ? ` by ${by}` : ""}`;
  if (ap.state === "denied") return `Denied${by ? ` by ${by}` : ""}`;
  if (ap.state === "expired") return "No answer in time, so no";
  if (ap.state === "cancelled") return "Cancelled";
  return "Waiting for you";
}

export async function decide(id: string, decision: "allow_once" | "allow_always" | "deny"): Promise<Approval> {
  return (await api.post(`/api/approvals/${id}/decide`, { decision })).approval;
}

function ApprovalCard({ m, ap }: { m: Message; ap?: Approval }) {
  const { user, fail, go, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const state = (m.meta.state as Approval["state"]) ?? ap?.state ?? "pending";
  const d = ap?.detail ?? {};
  const act = async (decision: "allow_once" | "allow_always" | "deny") => {
    setBusy(true);
    try {
      await decide(m.meta.approvalId, decision);
      toast(decision === "deny" ? "Denied. The agent was told." : "Approved");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const decided = { state, decision: m.meta.decision ?? ap?.decision ?? null, decidedBy: m.meta.decidedBy ?? ap?.decidedBy ?? null };
  return (
    <div className="card" style={{ borderColor: state === "pending" ? "#F3DDAA" : undefined }}>
      <div className="card-h">
        <Icon n="shield" size="sm" style={{ color: state === "pending" ? "var(--waiting)" : "var(--ink-3)" }} />
        {m.body}
      </div>
      <div className="card-b">
        {d.tool || d.title ? (
          <div style={{ background: "var(--bg)", borderRadius: 14, padding: "10px 12px" }}>
            <code className="tool" style={{ background: "none", padding: 0 }}>
              {d.tool ? `${d.tool}(${argsSummary(d.args)})` : d.title}
            </code>
          </div>
        ) : null}
        <div className="small muted" style={{ marginTop: 8 }}>
          {d.identity ? `as ${d.identity}` : d.sandbox ? `inside its ${d.sandbox} sandbox` : ""}
          {ap ? `${d.identity || d.sandbox ? " · " : ""}asked ${hhmm(ap.createdAt)}` : ""}
        </div>
      </div>
      <div className="card-f">
        {state === "pending" ? (
          <>
            <button className="btn primary sm" disabled={busy} onClick={() => act("allow_once")}>
              Approve once
            </button>
            <button className="btn sm" disabled={busy} onClick={() => act("allow_always")}>
              {ap?.source === "acp" ? "Always for this agent" : "Always in this chat"}
            </button>
            <button className="btn sm ghost" disabled={busy} onClick={() => act("deny")}>
              Deny
            </button>
            <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => go(`/needs/${m.meta.approvalId}`)}>
              Details
            </button>
          </>
        ) : (
          <span className={`status ${state === "approved" ? "done" : state === "denied" ? "blocked" : "sleeping"}`}>
            <Icon n={state === "approved" ? "check" : "x"} />
            {decisionText(decided as any, (id) => user(id)?.name ?? "someone")}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- composer
function Composer({ chat, agents, placeholder, onOpenInfo }: { chat: Chat; agents: Agent[]; placeholder: string; onOpenInfo: () => void }) {
  const { fail } = useStore();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);

  // Warm the chat's agents when it opens and again when typing starts (at most once a minute),
  // so an agent that went to sleep is already up by the time the message is sent.
  const warmedAt = useRef(0);
  const warm = useCallback(() => {
    if (Date.now() - warmedAt.current < 60_000) return;
    warmedAt.current = Date.now();
    api.post(`/api/chats/${chat.id}/warm`).catch(() => undefined);
  }, [chat.id]);
  useEffect(() => {
    ta.current?.focus();
    warmedAt.current = 0;
    warm();
  }, [chat.id, warm]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [text]);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    const list: (Agent | "all")[] = agents.filter((a) => a.handle.startsWith(q) || a.name.toLowerCase().startsWith(q));
    // @all: every agent in a group answers
    if (chat.kind === "group" && agents.length > 1 && ["all", "everyone"].some((w) => w.startsWith(q))) list.unshift("all");
    return list;
  }, [mention, agents, chat.kind]);

  const detect = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const mm = /(^|[^\w@])@([a-z0-9_-]*)$/i.exec(before);
    if (mm) {
      setMention({ q: mm[2], start: caret - mm[2].length - 1 });
      setSel(0);
    } else setMention(null);
  };
  const pick = (a: Agent | "all") => {
    if (!mention) return;
    const el = ta.current!;
    const caret = el.selectionStart;
    const h = a === "all" ? "all" : a.handle;
    const next = text.slice(0, mention.start) + "@" + h + " " + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = mention.start + h.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await api.post(`/api/chats/${chat.id}/messages`, { body });
      setText("");
      setMention(null);
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };
  const onKey = (e: RKE<HTMLTextAreaElement>) => {
    if (mention && (matches.length > 0 || e.key === "Escape")) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s - 1 + matches.length) % matches.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && matches[sel]) {
        e.preventDefault();
        pick(matches[sel]);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div style={{ position: "relative" }}>
      {mention && (
        <div className="card mention-pop">
          <div className="small muted" style={{ fontWeight: 600, padding: "6px 10px" }}>
            Agents in this chat
          </div>
          {matches.length === 0 && (
            <div className="small muted" style={{ padding: "6px 10px" }}>
              {agents.length ? "No agent by that name here." : "No agents in this chat yet."}
            </div>
          )}
          {matches.map((a, i) =>
            a === "all" ? (
              <div
                key="all"
                className={"row-chat" + (i === sel ? " on" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick("all");
                }}
              >
                <span className="all-av" aria-hidden="true">
                  {agents.slice(0, 3).map((x) => (
                    <AgentAv key={x.id} a={x} size={26} dot={false} />
                  ))}
                </span>
                <div className="mid">
                  <div className="t">
                    <b>Everyone</b>
                  </div>
                  <div className="p">@all · all {agents.length} agents answer</div>
                </div>
              </div>
            ) : (
            <div
              key={a.id}
              className={"row-chat" + (i === sel ? " on" : "")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
            >
              <AgentAv a={a} size={40} />
              <div className="mid">
                <div className="t">
                  <b>{a.name}</b>
                  <time>{a.roleTitle}</time>
                </div>
                <div className="p">
                  @{a.handle} · {statusLabel(a.status)}
                  {a.status.detail && vis(a.status) === "working" ? ` · ${a.status.detail}` : ""}
                </div>
              </div>
            </div>
            ),
          )}
          {chat.kind === "group" && (
            <div
              className="row"
              style={{ padding: "8px 10px", gap: 10, borderTop: "1px solid var(--line)", marginTop: 4, color: "var(--ink-2)", fontSize: 14, cursor: "pointer" }}
              onMouseDown={(e) => {
                e.preventDefault();
                setMention(null);
                onOpenInfo();
              }}
            >
              <span style={{ width: 36, height: 36, borderRadius: 11, background: "var(--bg)", display: "grid", placeItems: "center" }}>
                <Icon n="plus" />
              </span>
              Add an agent to this chat
            </div>
          )}
        </div>
      )}
      <div className="composer">
        <div className="field" style={mention ? { background: "var(--surface)", boxShadow: "inset 0 0 0 1.5px var(--accent)" } : undefined}>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label="Message"
            onChange={(e) => {
              setText(e.target.value);
              warm();
              detect(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKey}
            onClick={(e) => detect(text, e.currentTarget.selectionStart)}
            onBlur={() => setTimeout(() => setMention(null), 150)}
          />
          <button
            className="round"
            aria-label="Mention an agent"
            title="Mention an agent"
            onClick={() => {
              const next = text + (text && !/\s$/.test(text) ? " @" : "@");
              setText(next);
              setMention({ q: "", start: next.length - 1 });
              ta.current?.focus();
            }}
          >
            <Icon n="at" />
          </button>
          <button className="round send" aria-label="Send" onClick={send} disabled={sending || !text.trim()}>
            <Icon n="send" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ================================================================ group info drawer
function GroupInfo({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const { agent, user, users, agents, me, go, fail, toast } = useStore();
  const [adding, setAdding] = useState<"" | "agent" | "user">("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [memCount, setMemCount] = useState(0);
  const [name, setName] = useState(chat.name);
  useEffect(() => {
    api
      .get(`/api/tasks?chat=${chat.id}`)
      .then((r) => setTasks(r.tasks))
      .catch(() => {});
    api
      .get(`/api/memories?scope=chat&scopeId=${chat.id}`)
      .then((r) => setMemCount(r.memories.filter((m: any) => !m.forgottenAt).length))
      .catch(() => {});
  }, [chat.id]);
  const agentMembers = chat.members.filter((m) => m.type === "agent");
  const userMembers = chat.members.filter((m) => m.type === "user");
  const member = async (type: "agent" | "user", id: string, remove = false) => {
    try {
      await api.post(`/api/chats/${chat.id}/members`, { type, id, remove });
      toast(remove ? "Removed from the chat" : "Added to the chat");
    } catch (e) {
      fail(e);
    }
  };
  const rename = async () => {
    if (!name.trim() || name === chat.name) return;
    try {
      await api.patch(`/api/chats/${chat.id}`, { name });
      toast("Renamed");
    } catch (e) {
      fail(e);
    }
  };
  const open = tasks.filter((t) => t.status !== "done").length;
  return (
    <div className="drawer-p pane" style={{ background: "var(--surface)", gap: 0, padding: 0, overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 10px 0" }}>
        <button className="btn icon ghost" aria-label="Close" onClick={onClose}>
          <Icon n="x" />
        </button>
      </div>
      <div style={{ textAlign: "center", padding: "0 20px 18px" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <ChatAvatar c={chat} size={88} />
        </div>
        {chat.kind === "group" ? (
          <input
            className="input sm"
            style={{ marginTop: 10, textAlign: "center", fontSize: 20, fontWeight: 700, background: "transparent" }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Chat name"
          />
        ) : (
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 10 }}>{chatTitle(chat, agent)}</div>
        )}
        <div className="small muted">
          {userMembers.length} {userMembers.length === 1 ? "person" : "people"} · {agentMembers.length} {agentMembers.length === 1 ? "agent" : "agents"}
        </div>
      </div>
      <div style={{ padding: "0 16px 16px" }}>
        <div className="sect" style={{ marginTop: 4 }}>
          Agents
        </div>
        <div className="group">
          {agentMembers.map((m) => {
            const a = agent(m.id);
            if (!a) return null;
            return (
              <div key={m.id} className="it" style={{ padding: "10px 14px", cursor: "pointer" }} onClick={() => go(`/agents/${a.id}`)}>
                <AgentAv a={a} size={40} />
                <div className="grow">
                  <b style={{ fontWeight: 600 }}>{a.name}</b>
                  <div className="small muted">{a.roleTitle || `@${a.handle}`}</div>
                </div>
                <StatusPill s={a.status} />
                {chat.kind === "group" && (
                  <button
                    className="btn icon ghost sm"
                    title="Remove from chat"
                    aria-label={`Remove ${a.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      member("agent", a.id, true);
                    }}
                  >
                    <Icon n="x" size="sm" />
                  </button>
                )}
              </div>
            );
          })}
          {chat.kind !== "dm" && (
            <div className="it" style={{ padding: "10px 14px", color: "var(--accent)", fontWeight: 500, cursor: "pointer" }} onClick={() => setAdding("agent")}>
              <span className="ic" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                <Icon n="plus" />
              </span>
              Add an agent
            </div>
          )}
        </div>
        <div className="sect">People</div>
        <div className="group">
          {userMembers.map((m) => (
            <div key={m.id} className="it" style={{ padding: "10px 14px" }}>
              <UserAv u={user(m.id)} size={40} dot={m.id === me.id} />
              <div className="grow">
                <b style={{ fontWeight: 600 }}>{user(m.id)?.name ?? "someone"}</b> {m.id === me.id && <span className="small muted">you</span>}
              </div>
              {chat.kind === "group" && m.id !== me.id && (
                <button className="btn icon ghost sm" title="Remove from chat" aria-label="Remove" onClick={() => member("user", m.id, true)}>
                  <Icon n="x" size="sm" />
                </button>
              )}
            </div>
          ))}
          {chat.kind === "group" && (
            <div className="it" style={{ padding: "10px 14px", color: "var(--accent)", fontWeight: 500, cursor: "pointer" }} onClick={() => setAdding("user")}>
              <span className="ic" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                <Icon n="plus" />
              </span>
              Add a person
            </div>
          )}
        </div>
        <div className="sect">In this chat</div>
        <div className="group">
          <div className="it" style={{ cursor: "pointer" }} onClick={() => go(`/tasks/${chat.id}`)}>
            <span className="ic">
              <Icon n="board" />
            </span>
            Tasks
            <span className="right">
              {open} open
              <Icon n="right" size="sm" />
            </span>
          </div>
          <div className="it" style={{ cursor: "pointer" }} onClick={() => go(`/memory?f=chat&id=${chat.id}`)}>
            <span className="ic">
              <Icon n="memory" />
            </span>
            What this chat remembers
            <span className="right">
              {memCount}
              <Icon n="right" size="sm" />
            </span>
          </div>
        </div>
      </div>
      {adding && (
        <PickMembers
          title={adding === "agent" ? "Add an agent" : "Add a person"}
          options={
            adding === "agent"
              ? agents.filter((a) => !chat.members.some((m) => m.type === "agent" && m.id === a.id)).map((a) => ({ type: "agent" as const, id: a.id }))
              : users.filter((u) => !chat.members.some((m) => m.type === "user" && m.id === u.id)).map((u) => ({ type: "user" as const, id: u.id }))
          }
          onClose={() => setAdding("")}
          onPick={async (list) => {
            for (const m of list) await member(m.type, m.id);
            setAdding("");
          }}
        />
      )}
    </div>
  );
}

// ================================================================ pickers + new chat
export function MemberChip({ m, on, onClick }: { m: Member; on: boolean; onClick: () => void }) {
  const { agent, user } = useStore();
  const name = m.type === "agent" ? (agent(m.id)?.name ?? "agent") : (user(m.id)?.name ?? "someone");
  return (
    <span className={"chip" + (on ? " on" : "")} onClick={onClick} role="checkbox" aria-checked={on}>
      <MemberAv m={m} size={28} />
      {name}
      {on && <Icon n="check" size="sm" />}
    </span>
  );
}

function PickMembers({ title, options, onClose, onPick }: { title: string; options: Member[]; onClose: () => void; onPick: (m: Member[]) => void }) {
  const [sel, setSel] = useState<Member[]>([]);
  const has = (m: Member) => sel.some((x) => x.id === m.id && x.type === m.type);
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!sel.length} onClick={() => onPick(sel)}>
            Add {sel.length || ""}
          </button>
        </>
      }
    >
      {options.length === 0 ? (
        <div className="muted small">Everyone is already here.</div>
      ) : (
        <div className="pickbox">
          {options.map((m) => (
            <MemberChip key={m.type + m.id} m={m} on={has(m)} onClick={() => setSel(has(m) ? sel.filter((x) => !(x.id === m.id && x.type === m.type)) : [...sel, m])} />
          ))}
        </div>
      )}
    </Modal>
  );
}

function NewChatModal({ onClose }: { onClose: () => void }) {
  const { agents, users, me, go, fail, reloadChats } = useStore();
  const [name, setName] = useState("");
  const [sel, setSel] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const has = (m: Member) => sel.some((x) => x.id === m.id && x.type === m.type);
  const flip = (m: Member) => setSel(has(m) ? sel.filter((x) => !(x.id === m.id && x.type === m.type)) : [...sel, m]);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post("/api/chats", {
        name,
        agents: sel.filter((m) => m.type === "agent").map((m) => m.id),
        users: sel.filter((m) => m.type === "user").map((m) => m.id),
      });
      await reloadChats();
      onClose();
      go(`/chats/${r.chat.id}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New chat"
      sub="A group for people and agents"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>
            Start the chat
          </button>
        </>
      }
    >
      <div className="form">
        <div>
          <label className="label" htmlFor="cn">
            Name
          </label>
          <input id="cn" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch crew" autoFocus onKeyDown={(e) => e.key === "Enter" && name.trim() && create()} />
        </div>
        <div>
          <label className="label">Agents</label>
          {agents.length === 0 ? (
            <div className="small muted">No agents yet.</div>
          ) : (
            <div className="pickbox">
              {agents.map((a) => (
                <MemberChip key={a.id} m={{ type: "agent", id: a.id }} on={has({ type: "agent", id: a.id })} onClick={() => flip({ type: "agent", id: a.id })} />
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="label">People</label>
          {users.filter((u) => u.id !== me.id).length === 0 ? (
            <div className="small muted">Nobody else here yet. Add people in People and agents.</div>
          ) : (
            <div className="pickbox">
              {users
                .filter((u) => u.id !== me.id)
                .map((u) => (
                  <MemberChip key={u.id} m={{ type: "user", id: u.id }} on={has({ type: "user", id: u.id })} onClick={() => flip({ type: "user", id: u.id })} />
                ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export async function openDm(agentId: string): Promise<string> {
  return (await api.post("/api/chats", { dmAgent: agentId })).chat.id;
}

function MessageAgentModal({ onClose }: { onClose: () => void }) {
  const { agents, go, fail, reloadChats } = useStore();
  const pick = async (a: Agent) => {
    try {
      const id = await openDm(a.id);
      await reloadChats();
      onClose();
      go(`/chats/${id}`);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal title="Message an agent" sub="One to one, like texting" onClose={onClose} width={460}>
      {agents.length === 0 && (
        <div className="small muted">
          No agents yet.{" "}
          <span className="linkish" onClick={() => go("/agents/new")}>
            Add one
          </span>
        </div>
      )}
      {agents.map((a) => (
        <div key={a.id} className="row-chat" style={{ margin: 0 }} onClick={() => pick(a)}>
          <AgentAv a={a} size={40} />
          <div className="mid">
            <div className="t">
              <b>{a.name}</b>
              <time>@{a.handle}</time>
            </div>
            <div className="p">
              {a.roleTitle || "Agent"} · {statusLabel(a.status)}
            </div>
          </div>
        </div>
      ))}
    </Modal>
  );
}
