// SPDX-License-Identifier: AGPL-3.0-only
// Agent profile, the live session view ("Watch"), and adding or importing an agent.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type ActivityEntry, type Agent, type AgentStatus, type Chat, type Delivery, type Memory } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import {
  AUTONOMY,
  AgentAv,
  Blob,
  COLOURS,
  COLOUR_NAMES,
  EngIcon,
  Icon,
  Modal,
  STYLES,
  STYLE_NAMES,
  Seg,
  StatusPill,
  Swatch,
  ago,
  dollars,
  hhmm,
  statusLabel,
  tintVars,
  vis,
} from "../ui/ui.tsx";
import { ChatAvatar, chatTitle, openDm } from "./Chats.tsx";
import { ProviderModal } from "./Settings.tsx";

interface EngineInfo {
  id: string;
  name: string;
  vendor: string;
  description: string;
  installed: boolean;
  version: string;
  agents: string[];
  job: { state: string; log: string } | null;
  providerKinds: string[];
  dockerfile: boolean;
}
interface Provider {
  id: string;
  kind: string;
  baseUrl: string;
  models: string[];
  label: string;
  hasKey: boolean;
}

function useEnginesAndModels() {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    api
      .get("/api/engines")
      .then((r) => setEngines((r.engines as EngineInfo[]).filter((e) => !e.id.startsWith("mock"))))
      .catch(() => {});
    api
      .get("/api/providers")
      // "provider:model" pins the provider, so switching an agent to your own key is one pick
      .then((r) =>
        setModels(
          (r.providers as (Provider & { builtin?: boolean })[]).flatMap((p) =>
            p.models.map((m) => ({ value: `${p.id}:${m}`, label: p.builtin || p.id === "circlechat" ? "CircleChat models (included credits)" : `${p.label || p.id}: ${m}` })),
          ),
        ),
      )
      .catch(() => {});
  }, []);
  return { engines, models };
}

// ================================================================ agents list column
function AgentsList({ active }: { active?: string }) {
  const { agents, go, isBuilder } = useStore();
  return (
    <div className="list">
      <div className="list-top">
        <h2>
          Agents
          {isBuilder && (
            <button className="btn icon soft" aria-label="Add an agent" title="Add an agent" onClick={() => go("/agents/new")}>
              <Icon n="plus" />
            </button>
          )}
        </h2>
      </div>
      <div className="scroll" style={{ marginTop: 8 }}>
        {agents.map((a) => (
          <div key={a.id} className={"row-chat" + (a.id === active ? " on" : "")} onClick={() => go(`/agents/${a.id}`)}>
            <AgentAv a={a} size={48} />
            <div className="mid">
              <div className="t">
                <b>{a.name}</b>
              </div>
              <div className="p">
                {a.roleTitle || `@${a.handle}`} · {vis(a.status) === "working" && a.status.detail ? a.status.detail : statusLabel(a.status).toLowerCase()}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ================================================================ profile
export function ProfileScreen({ id }: { id: string }) {
  const { agent, upsertAgent, chat, go, fail, toast, isBuilder, isAdmin, reloadChats, reloadAgents } = useStore();
  const [chats, setChats] = useState<Chat[]>([]);
  const [mems, setMems] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState<Agent | null>(null);
  const [sessionPick, setSessionPick] = useState(false);
  const { engines, models } = useEnginesAndModels();
  const a = agent(id) ?? loaded;

  useEffect(() => {
    api
      .get(`/api/agents/${id}`)
      .then((r) => {
        setLoaded(r.agent);
        setChats(r.chats.filter(Boolean));
        setMems(r.memories);
      })
      .catch(fail);
  }, [id, fail]);

  const [draft, setDraft] = useState({ name: "", roleTitle: "", instructions: "", engine: "", model: "", sandbox: "docker" as Agent["sandbox"], budget: "" });
  useEffect(() => {
    if (a)
      setDraft({
        name: a.name,
        roleTitle: a.roleTitle,
        instructions: a.instructions,
        engine: a.engine,
        model: a.model,
        sandbox: a.sandbox,
        budget: a.budgetCents ? String(a.budgetCents / 100) : "",
      });
    // only when switching agents or after a save
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id, a?.instructions, a?.engine, a?.model, a?.sandbox, a?.budgetCents, a?.name, a?.roleTitle]);

  if (!a)
    return (
      <div className="main">
        <AgentsList active={id} />
        <div className="convo pane" style={{ background: "var(--bg)" }} />
      </div>
    );

  const patch = async (b: Partial<Agent> & { budgetCents?: number }, msg = "Saved") => {
    try {
      const r = await api.patch(`/api/agents/${a.id}`, b);
      upsertAgent(r.agent);
      setLoaded(r.agent);
      toast(msg);
    } catch (e) {
      fail(e);
    }
  };
  const action = async (act: "pause" | "wake" | "restart" | "cancel") => {
    try {
      const r = await api.post(`/api/agents/${a.id}/${act}`);
      upsertAgent({ ...a, status: r.status });
      toast(act === "pause" ? `${a.name} is paused. Nothing is lost.` : act === "wake" ? `${a.name} is awake` : act === "restart" ? "Restarted" : "Turn cancelled");
    } catch (e) {
      fail(e);
    }
  };
  const message = async () => {
    try {
      const cid = await openDm(a.id);
      await reloadChats();
      go(`/chats/${cid}`);
    } catch (e) {
      fail(e);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${a.name}? Its chats and history stay, but it stops working.`)) return;
    try {
      await api.del(`/api/agents/${a.id}`);
      await reloadAgents();
      toast(`${a.name} was removed`);
      go("/people");
    } catch (e) {
      fail(e);
    }
  };
  const v = vis(a.status);
  const paused = a.status.state === "stopped" || a.status.state === "sleeping" || a.status.state === "crashed";
  const workingIn = a.status.chatId ? chat(a.status.chatId) : undefined;
  const bigBtn = (icon: string, label: string, onClick: () => void, disabled = false) => (
    <button
      className="btn"
      disabled={disabled}
      onClick={onClick}
      style={{ flexDirection: "column", height: 64, width: 96, borderRadius: 16, gap: 2, borderColor: "transparent", boxShadow: "var(--sh-1)" }}
    >
      <Icon n={icon} />
      <span className="small">{label}</span>
    </button>
  );
  const engineDirty = draft.engine !== a.engine || draft.model !== a.model || draft.sandbox !== a.sandbox;
  const engineList = engines.some((e) => e.id === a.engine) ? engines : [{ id: a.engine, name: a.engine.startsWith("mock") ? "Test engine" : a.engine } as EngineInfo, ...engines];

  return (
    <div className="main">
      <AgentsList active={id} />
      <div className="convo pane" style={{ background: "var(--bg)" }}>
        <div style={{ maxWidth: 580, margin: "0 auto", padding: "30px 24px 60px", width: "100%" }}>
          <div style={{ textAlign: "center" }}>
            <Blob style={a.style} colour={a.colour} size={132} state={v} />
            <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-.02em", marginTop: 10 }}>{a.name}</h2>
            <div className="muted">
              {a.roleTitle || "Agent"} · @{a.handle} · joined {new Date(a.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
            </div>
            <div style={{ marginTop: 10 }}>
              <StatusPill s={a.status} text={v === "working" ? `Working${workingIn ? ` in ${chatTitle(workingIn, agent)}` : ""}${a.status.detail ? `: ${a.status.detail.slice(0, 40)}` : ""}` : undefined} />
            </div>
            <div className="row" style={{ justifyContent: "center", gap: 10, marginTop: 18 }}>
              {bigBtn("chat", "Message", message)}
              {bigBtn("monitor", "Watch", () => go(`/agents/${a.id}/watch`))}
              {bigBtn("memory", "Memory", () => go(`/memory?f=agent&id=${a.id}`))}
              {isBuilder && (paused ? bigBtn("play", "Wake", () => action("wake")) : bigBtn("pause", "Pause", () => action("pause")))}
            </div>
          </div>

          <div className="sect">Look</div>
          <div className="group">
            <div className="it" style={{ flexWrap: "wrap" }}>
              <Blob style={a.style} colour={a.colour} size={44} />
              <div className="grow">
                <b style={{ fontWeight: 600 }}>{STYLE_NAMES[a.style]}</b>
                <div className="small muted" style={{ textTransform: "none" }}>
                  {cap(a.colour)} · click a colour to change it
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {COLOUR_NAMES.map((c) => (
                  <Swatch key={c} c={c} on={c === a.colour} size={20} onClick={() => isBuilder && c !== a.colour && patch({ colour: c }, "Colour changed")} />
                ))}
              </div>
            </div>
            <div className="it" style={{ display: "grid", gridTemplateColumns: "repeat(13, 1fr)", gap: 4 }}>
              {STYLES.map((s) => (
                <span key={s} className={"stylepick" + (s === a.style ? " on" : "")} title={STYLE_NAMES[s]} onClick={() => isBuilder && s !== a.style && patch({ style: s }, "Style changed")}>
                  <Blob style={s} colour={a.colour} size={34} />
                </span>
              ))}
            </div>
          </div>

          <div className="sect">About</div>
          <div className="group" style={{ padding: 16 }}>
            <div className="field-row">
              <div>
                <label className="label">Name</label>
                <input className="input sm" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={!isBuilder} />
              </div>
              <div>
                <label className="label">Job</label>
                <input className="input sm" value={draft.roleTitle} onChange={(e) => setDraft({ ...draft, roleTitle: e.target.value })} disabled={!isBuilder} />
              </div>
            </div>
            <label className="label" style={{ marginTop: 14 }}>
              What should {a.name} know?
            </label>
            <textarea className="input" style={{ minHeight: 120 }} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} disabled={!isBuilder} placeholder="How it works, what it should never do, who to ask." />
            {isBuilder && (
              <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
                <button
                  className="btn primary sm"
                  disabled={draft.instructions === a.instructions && draft.name === a.name && draft.roleTitle === a.roleTitle}
                  onClick={() => patch({ instructions: draft.instructions, name: draft.name, roleTitle: draft.roleTitle })}
                >
                  Save
                </button>
              </div>
            )}
          </div>

          <div className="sect">How much {a.name} does on its own</div>
          <Seg full value={a.autonomy} options={AUTONOMY} onChange={(v) => isBuilder && patch({ autonomy: v }, "Updated")} />
          <div className="hint">
            {a.autonomy === "ask" ? "Asks you before anything outside its own sandbox." : a.autonomy === "act" ? "Works inside its sandbox freely, asks before risky actions." : "Never asks inside its sandbox. Connected apps still follow their own rules."}
          </div>

          <div className="sect">Engine and session</div>
          <div className="group">
            <div className="it">
              <EngIcon id={draft.engine} size={34} />
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <select className="input sm" value={draft.engine} onChange={(e) => setDraft({ ...draft, engine: e.target.value })} disabled={!isBuilder} aria-label="Engine">
                    {engineList.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                        {e.version ? ` ${e.version}` : ""}
                      </option>
                    ))}
                  </select>
                  <input className="input sm" list="model-list" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="Default model" disabled={!isBuilder} aria-label="Model" />
                  <datalist id="model-list">
                    {models.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </datalist>
                </div>
              </div>
            </div>
            <div className="it">
              <span className="ic">
                <Icon n="box" />
              </span>
              <div className="grow">
                Sandbox
                <div className="small muted">{draft.sandbox === "docker" ? "Its own container and home folder" : "Runs on this server as a local process"}</div>
              </div>
              <Seg
                value={draft.sandbox}
                options={[
                  ["docker", "Docker"],
                  ["local", "Local"],
                ]}
                onChange={(v) => isBuilder && setDraft({ ...draft, sandbox: v })}
              />
            </div>
            {engineDirty && (
              <div className="it" style={{ justifyContent: "flex-end", gap: 8 }}>
                <span className="small muted grow">Saving restarts {a.name}. Memory is kept.</span>
                <button className="btn sm ghost" onClick={() => setDraft({ ...draft, engine: a.engine, model: a.model, sandbox: a.sandbox })}>
                  Undo
                </button>
                <button className="btn primary sm" onClick={() => patch({ engine: draft.engine, model: draft.model, sandbox: draft.sandbox }, "Saved. It restarts on the next message.")}>
                  Save
                </button>
              </div>
            )}
            <div className="it">
              <span className="ic">
                <Icon n="terminal" />
              </span>
              <div className="grow">
                Session
                <div className="small muted">
                  {statusLabel(a.status)} · heartbeat {ago(a.status.heartbeat)}
                </div>
              </div>
              <button className="btn sm soft" onClick={() => go(`/agents/${a.id}/watch`)}>
                Open session
              </button>
              <button className="btn sm soft" onClick={() => setSessionPick(true)}>
                New session
              </button>
            </div>
          </div>

          <div className="sect">Spending</div>
          <div className="group">
            <div className="it" style={{ justifyContent: "space-around", textAlign: "center" }}>
              <div>
                <div className="big-n">{dollars(a.monthCostMicros)}</div>
                <div className="small muted">this month</div>
              </div>
              <div>
                <div className="big-n">{a.budgetCents ? `$${(a.budgetCents / 100).toFixed(0)}` : "None"}</div>
                <div className="small muted">monthly budget</div>
              </div>
            </div>
            {isBuilder && (
              <div className="it">
                Monthly budget
                <span className="right" style={{ gap: 8 }}>
                  <span className="muted">$</span>
                  <input
                    className="input sm"
                    style={{ width: 100 }}
                    inputMode="decimal"
                    value={draft.budget}
                    placeholder="no limit"
                    onChange={(e) => setDraft({ ...draft, budget: e.target.value.replace(/[^0-9.]/g, "") })}
                    aria-label="Monthly budget in dollars"
                  />
                  <button className="btn sm" disabled={Math.round(Number(draft.budget || 0) * 100) === a.budgetCents} onClick={() => patch({ budgetCents: Math.round(Number(draft.budget || 0) * 100) })}>
                    Save
                  </button>
                </span>
              </div>
            )}
          </div>

          <div className="sect">Chats {a.name} is in</div>
          <div className="group">
            {chats.length === 0 && <div className="it muted small">Not in any chat yet.</div>}
            {chats.map((c) => (
              <div key={c.id} className="it" style={{ cursor: "pointer", padding: "10px 14px" }} onClick={() => go(`/chats/${c.id}`)}>
                <ChatAvatar c={c} size={40} />
                <span className="grow">{chatTitle(c, agent)}</span>
                <Icon n="right" size="sm" className="muted" />
              </div>
            ))}
          </div>

          <div className="sect">What {a.name} remembers</div>
          <div className="group">
            {mems.length === 0 && <div className="it muted small">Nothing yet.</div>}
            {mems.slice(0, 12).map((m) => (
              <div key={m.id} className="it" style={{ padding: "10px 14px", opacity: m.forgottenAt ? 0.5 : 1 }}>
                <span className="ic">
                  <Icon n="memory" />
                </span>
                <div className="grow">
                  {m.text}
                  <div className="small muted">
                    {m.scope === "agent" ? "Only for itself" : m.scope === "team" ? "For everyone" : "For one chat"} · {m.source}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="sect">Identity</div>
          <div className="group">
            <div className="it">
              <span className="ic">
                <Icon n="mail" />
              </span>
              <div className="grow">
                {a.email}
                <div className="small muted">Its own address</div>
              </div>
            </div>
          </div>
          {isAdmin && (
            <div style={{ marginTop: 28, textAlign: "center" }}>
              <button className="btn ghost danger" onClick={remove}>
                <Icon n="trash" size="sm" />
                Remove {a.name}
              </button>
            </div>
          )}
        </div>
      </div>
      {sessionPick && <NewSessionModal a={a} chats={chats} onClose={() => setSessionPick(false)} />}
    </div>
  );
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function NewSessionModal({ a, chats, onClose }: { a: Agent; chats: Chat[]; onClose: () => void }) {
  const { agent, fail, toast } = useStore();
  const start = async (chatId: string) => {
    try {
      await api.post(`/api/agents/${a.id}/new-session`, { chatId });
      toast("New session started. Memory kept.");
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal title="New session" sub={`${a.name} forgets the conversation in that chat, but keeps its memory.`} onClose={onClose} width={460}>
      {chats.length === 0 && <div className="small muted">{a.name} isn't in any chat yet.</div>}
      {chats.map((c) => (
        <div key={c.id} className="row-chat" style={{ margin: 0 }} onClick={() => start(c.id)}>
          <ChatAvatar c={c} size={40} />
          <div className="mid">
            <div className="t">
              <b>{chatTitle(c, agent)}</b>
            </div>
          </div>
        </div>
      ))}
    </Modal>
  );
}

// ================================================================ watch (session view)
interface Line {
  key: string;
  kind: ActivityEntry["kind"];
  ts: number;
  text: string;
  status?: string;
}
function toLines(entries: ActivityEntry[]): Line[] {
  const out: Line[] = [];
  const toolIdx = new Map<string, number>();
  entries.forEach((e, i) => {
    const prev = out[out.length - 1];
    if ((e.kind === "message" || e.kind === "thought") && prev && prev.kind === e.kind && e.ts - prev.ts < 15_000) {
      prev.text += e.text;
      return;
    }
    if (e.kind === "plan" && prev && prev.kind === "plan") {
      prev.text = e.text;
      prev.ts = e.ts;
      return;
    }
    if (e.kind === "tool" && e.toolCallId && toolIdx.has(e.toolCallId)) {
      const l = out[toolIdx.get(e.toolCallId)!];
      if (e.status) l.status = e.status;
      if (e.text && e.text !== "tool") l.text = e.text;
      return;
    }
    if (e.kind === "tool" && e.toolCallId) toolIdx.set(e.toolCallId, out.length);
    out.push({ key: `${e.ts}-${i}`, kind: e.kind, ts: e.ts, text: e.text, status: e.status });
  });
  return out;
}

function TermLine({ l }: { l: Line }) {
  const t = <span className="tt">{new Date(l.ts).toLocaleTimeString(undefined, { hour12: false })} </span>;
  let body: ReactNode;
  switch (l.kind) {
    case "prompt":
      body = (
        <>
          <span className="tp">› </span>
          <span className="tw">{l.text}</span>
        </>
      );
      break;
    case "thought":
      body = <span className="tdim">{l.text}</span>;
      break;
    case "tool": {
      const st = l.status ?? "";
      const cls = st === "completed" ? "tg" : st === "failed" ? "tr" : "ty";
      body = (
        <>
          <span className="tp">⏺ </span>
          <span className="tw">{l.text}</span>
          {st && <span className={cls}>{`  ${st === "in_progress" ? "running" : st}`}</span>}
        </>
      );
      break;
    }
    case "message":
      body = <span>{l.text}</span>;
      break;
    case "usage":
      body = <span className="tt">usage {l.text}</span>;
      break;
    case "lifecycle":
      body = <span className="tc">● {l.text}</span>;
      break;
    case "plan":
      body = <span className="tc">plan {l.text}</span>;
      break;
    case "error":
      body = <span className="tr">✕ {l.text}</span>;
      break;
    case "stderr":
      body = <span className="tt">{l.text}</span>;
      break;
  }
  return (
    <span className="tl">
      {t}
      {body}
    </span>
  );
}

export function WatchScreen({ id }: { id: string }) {
  const { agent, chat, go, fail, toast, upsertAgent, user, isBuilder } = useStore();
  const a = agent(id);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [queued, setQueued] = useState<Delivery[]>([]);
  const [, tick] = useState(0);
  const termRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = () =>
    api
      .get(`/api/agents/${id}/activity?limit=400`)
      .then((r) => {
        setEntries(r.activity);
        setStatus(r.status);
        setQueued(r.queued);
      })
      .catch(fail);
  useEffect(() => {
    load();
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useBus((e) => {
    if (e.type === "hello") load();
    if (e.type === "agent_activity" && e.agentId === id)
      setEntries((l) => {
        const last = l[l.length - 1];
        if (e.append && last && last.kind === e.entry.kind) return [...l.slice(0, -1), { ...last, text: last.text + e.entry.text }];
        return [...l, e.entry].slice(-800);
      });
    if (e.type === "agent_status" && e.agentId === id) setStatus(e.status);
    if (e.type === "delivery" && (e.delivery as Delivery).agentId === id) {
      const d = e.delivery as Delivery;
      setQueued((l) => (d.state === "queued" ? [...l.filter((x) => x.id !== d.id), d] : l.filter((x) => x.id !== d.id)));
    }
  });
  const lines = useMemo(() => toLines(entries), [entries]);
  useLayoutEffect(() => {
    const el = termRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!a)
    return (
      <div className="main solo">
        <div className="convo" />
      </div>
    );
  const s = status ?? a.status;
  const action = async (act: "pause" | "wake" | "restart" | "cancel") => {
    try {
      const r = await api.post(`/api/agents/${a.id}/${act}`);
      setStatus(r.status);
      upsertAgent({ ...a, status: r.status });
      toast(act === "pause" ? `${a.name} is paused. Nothing is lost.` : act === "wake" ? `${a.name} is awake` : act === "restart" ? "Restarted" : "Turn cancelled");
    } catch (e) {
      fail(e);
    }
  };
  const paused = s.state === "stopped" || s.state === "sleeping" || s.state === "crashed";
  const c = s.chatId ? chat(s.chatId) : undefined;
  const lastUsage = [...entries].reverse().find((e) => e.kind === "usage");
  const from = (d: Delivery) => (d.fromType === "user" ? (user(d.fromId)?.name ?? "someone") : d.fromType === "agent" ? (agent(d.fromId)?.name ?? "agent") : d.fromType === "trigger" ? d.fromId : "CircleChat");

  return (
    <div className="main solo">
      <div className="convo">
        <div className="convo-head">
          <AgentAv a={{ ...a, status: s }} size={44} onClick={() => go(`/agents/${a.id}`)} />
          <div style={{ minWidth: 0 }}>
            <h3>{a.name} · session</h3>
            <div className="sub">
              {a.engine.startsWith("mock") ? "Test engine" : a.engine}
              {a.model ? ` · ${a.model === "circlechat:standard" ? "CircleChat models" : a.model}` : ""} · {a.sandbox === "docker" ? "own container" : "local process"}
              {c ? ` · ${chatTitle(c, agent)}` : ""}
            </div>
          </div>
          <div className="right" style={{ alignItems: "center", gap: 8 }}>
            {vis(s) === "working" && (
              <span className="live">
                <i />
                Live
              </span>
            )}
            {isBuilder &&
              (paused ? (
                <button className="btn sm" onClick={() => action("wake")}>
                  <Icon n="play" size="sm" />
                  Wake
                </button>
              ) : (
                <button className="btn sm" onClick={() => action("pause")}>
                  <Icon n="pause" size="sm" />
                  Pause
                </button>
              ))}
            <button className="btn sm" onClick={() => action("cancel")} disabled={vis(s) !== "working" && vis(s) !== "waiting"}>
              <Icon n="x" size="sm" />
              Cancel turn
            </button>
            {isBuilder && (
              <button className="btn sm" onClick={() => action("restart")}>
                <Icon n="refresh" size="sm" />
                Restart
              </button>
            )}
          </div>
        </div>
        <div className="term-wrap">
          <div
            className="term"
            ref={termRef}
            onScroll={() => {
              const el = termRef.current;
              if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
          >
            {lines.length === 0 && <span className="tc">● Nothing yet. Send {a.name} a message and watch it work here.</span>}
            {lines.map((l) => (
              <TermLine key={l.key} l={l} />
            ))}
            {vis(s) === "working" && <span className="cursor" />}
            {vis(s) === "waiting" && (
              <span className="tl">
                <span className="ta">⏸ Waiting for approval</span> {s.detail}
              </span>
            )}
          </div>
          <div className="drawer-p" style={{ gap: 14 }}>
            <div className="small muted" style={{ fontWeight: 600 }}>
              Process
            </div>
            <div className="group">
              <div className="it" style={{ padding: "9px 12px" }}>
                <span className="grow small">State</span>
                <StatusPill s={s} />
              </div>
              {s.detail && (
                <div className="it" style={{ padding: "9px 12px" }}>
                  <span className="grow small">Doing</span>
                  <span className="small" style={{ maxWidth: 170, textAlign: "right", overflowWrap: "anywhere" }}>
                    {s.detail}
                  </span>
                </div>
              )}
              <div className="it" style={{ padding: "9px 12px" }}>
                <span className="grow small">Heartbeat</span>
                <span className="small num">{ago(s.heartbeat)}</span>
              </div>
              <div className="it" style={{ padding: "9px 12px" }}>
                <span className="grow small">In this state since</span>
                <span className="small num">{s.since ? hhmm(s.since) : "-"}</span>
              </div>
              <div className="it" style={{ padding: "9px 12px" }}>
                <span className="grow small">This month</span>
                <span className="small num">{dollars(a.monthCostMicros)}</span>
              </div>
              {lastUsage && (
                <div className="it" style={{ padding: "9px 12px" }}>
                  <span className="grow small">Last usage</span>
                  <span className="small num">{lastUsage.text}</span>
                </div>
              )}
            </div>
            <div className="small muted" style={{ fontWeight: 600 }}>
              Messages waiting for {a.name}
            </div>
            <div className="group">
              {queued.length === 0 && (
                <div className="it" style={{ padding: "9px 12px" }}>
                  <span className="small muted">None</span>
                </div>
              )}
              {queued.map((d) => (
                <div key={d.id} className="it" style={{ padding: "9px 12px", gap: 8 }}>
                  <span className="grow small" title={d.text}>
                    <b>{from(d)}:</b> "{d.text.length > 60 ? d.text.slice(0, 60) + "…" : d.text}"
                  </span>
                  <span className="tag-agent">queued</span>
                </div>
              ))}
            </div>
            <div className="row small muted" style={{ gap: 8, marginTop: "auto" }}>
              <Icon n="box" size="sm" />
              {a.sandbox === "docker" ? "Runs in its own container. No keys inside it." : "Runs as a local process on this server."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ================================================================ add an agent
const GREETINGS = (name: string, job: string, autonomy: Agent["autonomy"] = "ask") =>
  `Hi everyone, I'm ${name || "your new agent"}!${job ? ` I'll help with ${job.toLowerCase()}.` : ""} ${
    autonomy === "ask" ? "I'll ask before I change anything." : autonomy === "act" ? "I'll get on with it and tell you what I did." : "I'll work on my own and keep you posted."
  }`;

export function AddAgentScreen() {
  const { chats, agents, agent, go, fail, toast, reloadAgents, reloadChats, isBuilder, isAdmin, hosted } = useStore();
  const rnd = <T,>(l: T[]) => l[Math.floor(Math.random() * l.length)];
  const [f, setF] = useState(() => ({
    style: rnd(STYLES),
    colour: rnd(COLOUR_NAMES),
    name: "",
    handle: "",
    handleTouched: false,
    roleTitle: "",
    engine: "",
    model: "",
    modelTouched: false,
    sandbox: "docker" as Agent["sandbox"],
    autonomy: "act" as Agent["autonomy"],
    instructions: "",
    chats: [] as string[],
  }));
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [providers, setProviders] = useState<(Provider & { label?: string; builtin?: boolean })[]>([]);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editHandle, setEditHandle] = useState(false);
  const [more, setMore] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  const loadEngines = useCallback(
    () =>
      api
        .get("/api/engines")
        .then((r) => setEngines((r.engines as EngineInfo[]).filter((e) => !e.id.startsWith("mock"))))
        .catch(() => {}),
    [],
  );
  const loadProviders = useCallback(
    () =>
      api
        .get("/api/providers")
        .then((r) => setProviders(r.providers))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    loadEngines();
    loadProviders();
  }, [loadEngines, loadProviders]);
  // while an engine installs, check every few seconds and pick it when it's ready
  const installing = engines.filter((e) => e.job?.state === "running").map((e) => e.id);
  useEffect(() => {
    if (!installing.length) return;
    const t = setInterval(loadEngines, 3000);
    return () => clearInterval(t);
  }, [installing.join(","), loadEngines]);
  useEffect(() => {
    if (!f.engine && engines.length) set({ engine: (engines.find((e) => e.installed) ?? engines[0]).id });
  }, [engines, f.engine]);

  const engine = engines.find((e) => e.id === f.engine);
  // the models this engine can use, our own model first
  const models = useMemo(() => {
    const kinds = engine?.providerKinds ?? [];
    return providers
      .filter((p) => !kinds.length || kinds.includes(p.kind))
      .sort((x, y) => Number(y.id === "circlechat") - Number(x.id === "circlechat"))
      .flatMap((p) =>
        p.models.map((m) => ({
          value: `${p.id}:${m}`,
          label: p.id === "circlechat" ? (hosted ? "CircleChat standard (uses credits)" : "CircleChat standard") : `${p.label || p.id}: ${m}`,
        })),
      );
  }, [providers, engine?.providerKinds?.join(","), hosted]);
  useEffect(() => {
    if (f.modelTouched) {
      if (f.model && !models.some((m) => m.value === f.model)) set({ model: models[0]?.value ?? "" });
      return;
    }
    set({ model: models[0]?.value ?? "" });
  }, [models, f.modelTouched]);

  // the handle follows the name; if it's taken, add a number (kit, kit2, kit3…)
  const autoHandle = useMemo(() => {
    const base = f.name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 28);
    if (!base) return "";
    const taken = new Set(agents.map((a) => a.handle));
    let h = base,
      n = 2;
    while (taken.has(h)) h = `${base}${n++}`;
    return h;
  }, [f.name, agents]);
  const handle = f.handleTouched ? f.handle : autoHandle;
  const tint = COLOURS[f.colour];
  const who = f.name.trim() || "it";

  const install = async (e: EngineInfo) => {
    try {
      await api.post(`/api/engines/${e.id}/install`);
      toast(`Installing ${e.name}. This takes a few minutes, you can keep filling in the rest.`);
      set({ engine: e.id });
      loadEngines();
    } catch (x) {
      fail(x);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post("/api/agents", {
        name: f.name.trim(),
        handle,
        roleTitle: f.roleTitle,
        style: f.style,
        colour: f.colour,
        engine: f.engine || undefined,
        model: f.model,
        sandbox: f.sandbox,
        autonomy: f.autonomy,
        instructions: f.instructions,
        chats: f.chats,
      });
      await Promise.all([reloadAgents(), reloadChats()]);
      toast(`${r.agent.name} joined${f.chats.length ? ` ${f.chats.length} ${f.chats.length === 1 ? "chat" : "chats"}` : ""}`);
      go(`/agents/${r.agent.id}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  if (!isBuilder)
    return (
      <div className="main solo">
        <div className="big-empty">Only builders and admins can add agents.</div>
      </div>
    );

  const engineReady = !!engine?.installed;
  const groups = chats.filter((c) => c.kind === "group");
  return (
    <div className="main solo">
      <div className="convo pane add-agent" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 400px" }}>
        <div style={{ padding: "34px 48px", maxWidth: 720 }} className="col add-agent-form">
          <div className="row">
            <h2 className="h2">Add an agent</h2>
            <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setImporting(true)}>
              <Icon n="undo" size="sm" />
              Import from OpenClaw or Hermes
            </button>
          </div>
          <p className="muted" style={{ margin: "4px 0 26px" }}>
            Give it a name and a job. Everything else is ready to go.
          </p>

          <div className="field-row">
            <div>
              <label className="label">Name</label>
              <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Kit" autoFocus />
            </div>
            <div>
              <label className="label">Job</label>
              <input className="input" value={f.roleTitle} onChange={(e) => set({ roleTitle: e.target.value })} placeholder="Sales" />
            </div>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {editHandle ? (
              <span className="row" style={{ gap: 6 }}>
                People mention it as @
                <input
                  className="input sm"
                  style={{ maxWidth: 200 }}
                  value={handle}
                  autoFocus
                  onChange={(e) => set({ handle: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30), handleTouched: true })}
                  onBlur={() => setEditHandle(false)}
                  onKeyDown={(e) => e.key === "Enter" && setEditHandle(false)}
                  placeholder="kit"
                  aria-label="Handle"
                />
              </span>
            ) : (
              <>
                People mention it as <b>@{handle || "kit"}</b>.{" "}
                <button className="linkbtn" onClick={() => setEditHandle(true)}>
                  Change
                </button>
              </>
            )}
          </div>

          <div className="row" style={{ justifyContent: "space-between", marginTop: 24 }}>
            <label className="label" style={{ margin: 0 }}>
              Look
            </label>
            <button className="btn sm soft" onClick={() => set({ style: rnd(STYLES), colour: rnd(COLOUR_NAMES) })}>
              <Icon n="refresh" size="sm" />
              Shuffle
            </button>
          </div>
          <div className="stylepicks" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginTop: 10 }}>
            {STYLES.map((s) => (
              <span key={s} className={"stylepick" + (s === f.style ? " on" : "")} title={STYLE_NAMES[s]} onClick={() => set({ style: s })}>
                <Blob style={s} colour={f.colour} size={58} />
              </span>
            ))}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            {COLOUR_NAMES.map((c) => (
              <Swatch key={c} c={c} on={c === f.colour} onClick={() => set({ colour: c })} />
            ))}
          </div>

          <label className="label" style={{ marginTop: 26 }}>
            Engine <span className="muted" style={{ fontWeight: 400 }}>· the agent software {who} runs on</span>
          </label>
          <div className="eng-grid">
            {engines.map((e) => {
              const busyInstall = e.job?.state === "running";
              const failed = e.job?.state === "error" && !e.installed;
              return (
                <div
                  key={e.id}
                  className={"eng-card" + (f.engine === e.id ? " on" : "") + (e.installed ? "" : " off")}
                  onClick={() => (e.installed || busyInstall) && set({ engine: e.id })}
                  title={e.description}
                  role="button"
                  aria-pressed={f.engine === e.id}
                >
                  <EngIcon id={e.id} size={36} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <b>{e.name}</b>
                    <div className="small muted">
                      {e.installed ? "Ready" : busyInstall ? "Installing…" : failed ? "Install failed" : "Not installed"}
                    </div>
                  </div>
                  {!e.installed && !busyInstall && e.dockerfile && isAdmin && (
                    <button
                      className="btn xs"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        install(e);
                      }}
                    >
                      {failed ? "Retry" : "Install"}
                    </button>
                  )}
                  {busyInstall && <span className="spin" aria-hidden="true" />}
                </div>
              );
            })}
            {engines.length === 0 && <span className="small muted">Loading engines…</span>}
          </div>
          {engine && !engine.installed && !installing.includes(engine.id) && !isAdmin && (
            <div className="hint">Ask an admin to install {engine.name}.</div>
          )}

          <label className="label" style={{ marginTop: 22 }}>
            Model
          </label>
          <div className="row" style={{ gap: 10 }}>
            <select
              className="input sm"
              style={{ maxWidth: 360 }}
              value={f.model}
              onChange={(e) => (e.target.value === "__add" ? setAddingModel(true) : set({ model: e.target.value, modelTouched: true }))}
            >
              {models.length === 0 && <option value="">Engine default</option>}
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
              {isAdmin && <option value="__add">Add your own model or key…</option>}
            </select>
          </div>
          {models.length === 0 && engine && (
            <div className="hint">
              {engine.name} needs a model key{engine.providerKinds.length === 1 && engine.providerKinds[0] === "anthropic" ? " from Anthropic" : ""}.{" "}
              {isAdmin && (
                <button className="linkbtn" onClick={() => setAddingModel(true)}>
                  Add one
                </button>
              )}
            </div>
          )}

          <label className="label" style={{ marginTop: 22 }}>
            How much {who} does on its own
          </label>
          <div>
            <Seg value={f.autonomy} options={AUTONOMY} onChange={(v) => set({ autonomy: v })} />
          </div>

          {groups.length > 0 && (
            <>
              <label className="label" style={{ marginTop: 22 }}>
                Add {who} to <span className="muted" style={{ fontWeight: 400 }}>· optional, you can always message it directly</span>
              </label>
              <div className="pickbox">
                {groups.map((c) => {
                  const on = f.chats.includes(c.id);
                  return (
                    <span key={c.id} className={"chip" + (on ? " on" : "")} onClick={() => set({ chats: on ? f.chats.filter((x) => x !== c.id) : [...f.chats, c.id] })}>
                      <ChatAvatar c={c} size={28} />
                      {chatTitle(c, agent)}
                      {on && <Icon n="check" size="sm" />}
                    </span>
                  );
                })}
              </div>
            </>
          )}

          <button className="linkbtn more-toggle" style={{ marginTop: 24 }} onClick={() => setMore((x) => !x)} aria-expanded={more}>
            <Icon n={more ? "down" : "right"} size="sm" />
            More options
          </button>
          {more && (
            <div className="col" style={{ gap: 0 }}>
              <label className="label" style={{ marginTop: 14 }}>
                Add context <span className="muted" style={{ fontWeight: 400 }}>· optional</span>
              </label>
              <textarea
                className="input"
                value={f.instructions}
                onChange={(e) => set({ instructions: e.target.value })}
                placeholder="Anything that helps: what your team does, how you like things done, what to avoid."
              />
              <label className="label" style={{ marginTop: 18 }}>
                Where it runs
              </label>
              <Seg
                value={f.sandbox}
                options={[
                  ["docker", "Its own safe space"],
                  ["local", "Directly on the server"],
                ]}
                onChange={(v) => set({ sandbox: v })}
              />
              <div className="hint">
                {f.sandbox === "docker"
                  ? "Recommended. It works in a sealed box with its own files, so it can't touch the rest of the server."
                  : "For experts. It can see and change files on the server itself."}
              </div>
            </div>
          )}

          <div className="row" style={{ marginTop: 32, gap: 10 }}>
            <button className="btn primary lg" disabled={busy || !f.name.trim() || !handle || (!engineReady && !installing.includes(f.engine))} onClick={create}>
              Add {f.name.trim() || "agent"}
            </button>
            <button className="btn ghost lg" onClick={() => history.back()}>
              Cancel
            </button>
          </div>
          {engine && installing.includes(engine.id) && <div className="hint">{engine.name} is still installing. {f.name.trim() || "The agent"} will start once it's ready.</div>}
        </div>
        <div style={{ background: "var(--bg)", display: "grid", placeItems: "center", padding: 24, position: "sticky", top: 0, height: "100vh" }}>
          <div style={{ width: 340, textAlign: "center" }}>
            <Blob style={f.style} colour={f.colour} size={150} />
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{f.name || "New agent"}</div>
            <div className="muted small">{f.roleTitle || "Agent"}</div>
            <div className="m" style={{ marginTop: 24, textAlign: "left", maxWidth: "100%", ...tintVars({ colour: f.colour }) }}>
              <Blob style={f.style} colour={f.colour} size={40} />
              <div className="stackm">
                <div className="bub agent tail" style={{ background: tint.tint }}>
                  {GREETINGS(f.name, f.roleTitle, f.autonomy)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {importing && <ImportModal onClose={() => setImporting(false)} />}
      {addingModel && (
        <ProviderModal
          p={null}
          onClose={() => setAddingModel(false)}
          onSaved={(list) => {
            setAddingModel(false);
            setProviders(list as any);
            const added = (list as any[]).find((p) => !providers.some((o) => o.id === p.id));
            if (added?.models?.[0]) set({ model: `${added.id}:${added.models[0]}`, modelTouched: true });
          }}
        />
      )}
    </div>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const { go, fail, toast, reloadAgents } = useStore();
  const [path, setPath] = useState("");
  const [found, setFound] = useState<{ kind: string; name: string; instructions: string; memories: string[]; skills: string[] } | null>(null);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const inspect = async () => {
    setBusy(true);
    try {
      const r = await api.post("/api/agents/import/inspect", { path });
      setFound(r.found);
      setHandle(r.found.name.toLowerCase().replace(/[^a-z0-9_-]/g, ""));
    } catch (e) {
      fail(e);
      setFound(null);
    } finally {
      setBusy(false);
    }
  };
  const doImport = async () => {
    setBusy(true);
    try {
      const r = await api.post("/api/agents/import", { path, handle });
      await reloadAgents();
      toast(`Imported ${r.agent.name}: ${r.imported.memories} memories, ${r.imported.skills} skills`);
      go(`/agents/${r.agent.id}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Import an agent"
      sub="From an OpenClaw or Hermes folder on this server"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            Cancel
          </button>
          {found ? (
            <button className="btn primary" disabled={busy || !handle} onClick={doImport}>
              Import {found.name}
            </button>
          ) : (
            <button className="btn primary" disabled={busy || !path.trim()} onClick={inspect}>
              Look inside
            </button>
          )}
        </>
      }
    >
      <div className="form">
        <div>
          <label className="label">Folder path</label>
          <input
            className="input mono"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setFound(null);
            }}
            placeholder="/home/me/.openclaw/workspace"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && path.trim() && inspect()}
          />
          <div className="hint">The folder with its SOUL.md, AGENTS.md or memories.</div>
        </div>
        {found && (
          <div className="group" style={{ padding: "14px 16px" }}>
            <div className="kv">
              <dt>Found</dt>
              <dd>{found.kind === "openclaw" ? "OpenClaw agent" : "Hermes agent"}</dd>
              <dt>Name</dt>
              <dd>{found.name}</dd>
              <dt>Instructions</dt>
              <dd>{found.instructions ? `${found.instructions.length.toLocaleString()} characters` : "None"}</dd>
              <dt>Memories</dt>
              <dd>{found.memories.length}</dd>
              <dt>Skills</dt>
              <dd>{found.skills.length ? found.skills.slice(0, 6).join(", ") + (found.skills.length > 6 ? ` and ${found.skills.length - 6} more` : "") : "None"}</dd>
            </div>
            {found.instructions && <pre className="json" style={{ marginTop: 10, maxHeight: 140 }}>{found.instructions.slice(0, 600)}</pre>}
            <label className="label" style={{ marginTop: 12 }}>
              Handle
            </label>
            <input className="input sm" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} />
          </div>
        )}
      </div>
    </Modal>
  );
}
