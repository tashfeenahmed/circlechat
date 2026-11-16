// SPDX-License-Identifier: AGPL-3.0-only
// Settings: server (and, for the owner, data export and delete), engines, models and keys (with spend), Slack bridge,
// and the integrations: apps, MCP servers, triggers and the tool log.
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { AgentAv, COLOURS, EngIcon, Empty, Icon, Modal, UserAv, dollars } from "../ui/ui.tsx";
import { chatTitle } from "./Chats.tsx";
import { Apps, McpServers, ToolLog, Triggers } from "./Integrations.tsx";

export function SettingsScreen({ section, id }: { section: string; id?: string }) {
  const { go, hosted, isAdmin } = useStore();
  const it = (k: string, icon: string, label: string, sub: string) => (
    <div key={k} className={"row-chat" + (section === k ? " on" : "")} onClick={() => go(`/settings/${k}`)}>
      <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--bg)", display: "grid", placeItems: "center", color: "var(--ink-2)", flex: "none" }}>
        <Icon n={icon} />
      </span>
      <div className="mid">
        <div className="t">
          <b>{label}</b>
        </div>
        <div className="p">{sub}</div>
      </div>
    </div>
  );
  return (
    <div className="main">
      <div className="list">
        <div className="list-top">
          <h2>Settings</h2>
        </div>
        <div className="scroll" style={{ marginTop: 8 }}>
          {it("server", "server", "Server", "Workspace, you, notifications")}
          {hosted && isAdmin && it("credits", "dollar", "Credits", "AI credits for CircleChat models")}
          {hosted && isAdmin && it("hosting", "globe", "Hosting", "Plan, backups, server, domain")}
          {it("engines", "cpu", "Engines", "The CLI agents on this server")}
          {it("models", "key", "Models and keys", "Providers and spending")}
          {it("slack", "link", "Slack bridge", "Mirror a chat to Slack")}
          <div className="label" style={{ padding: "18px 24px 6px" }}>Integrations</div>
          {it("apps", "plug", "Apps", "Slack, Notion, GitHub and more")}
          {it("mcp", "server", "MCP servers", "Bring any MCP tool")}
          {it("triggers", "zap", "Triggers", "Webhooks and schedules")}
          {it("log", "list", "Tool log", "Every call, tamper-evident")}
        </div>
      </div>
      <div className="convo pane" style={{ background: "var(--bg)" }}>
        {section === "server" && <Server />}
        {section === "hosting" && hosted && isAdmin && <Hosting />}
        {section === "credits" && hosted && isAdmin && <Credits />}
        {section === "engines" && <Engines />}
        {section === "models" && <Models />}
        {section === "slack" && <Slack />}
        {section === "apps" && <Apps />}
        {section === "mcp" && <McpServers id={id} />}
        {section === "triggers" && <Triggers id={id} />}
        {section === "log" && <ToolLog />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- server
function Server() {
  const { workspace, setWorkspace, version, me, isAdmin, fail, toast, hosted } = useStore();
  const [name, setName] = useState(workspace);
  const [perm, setPerm] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const save = async () => {
    try {
      await api.put("/api/settings", { workspace: name });
      setWorkspace(name);
      toast("Saved");
    } catch (e) {
      fail(e);
    }
  };
  const logout = async () => {
    try {
      await api.post("/api/logout");
    } finally {
      location.href = "/";
    }
  };
  const askNotify = async () => {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setPerm(p);
    if (p === "granted") new Notification("Notifications are on", { body: "We'll ping you when an agent needs your OK or messages you." });
  };
  return (
    <div className="page">
      <h2 className="h2">Server</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        CircleChat {version} · {location.host}
      </p>
      <div className="sect">Workspace</div>
      <div className="group">
        <div className="it">
          Name
          <span className="right" style={{ gap: 8 }}>
            <input className="input sm" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} aria-label="Workspace name" />
            {isAdmin && (
              <button className="btn sm" disabled={!name.trim() || name === workspace} onClick={save}>
                Save
              </button>
            )}
          </span>
        </div>
        <div className="it">
          Version
          <span className="right num">{version}</span>
        </div>
      </div>
      <div className="sect">Desktop notifications</div>
      <div className="group">
        <div className="it">
          <span className="ic">
            <Icon n="bell" />
          </span>
          <div className="grow">
            When an agent needs your OK or messages you
            <div className="small muted">
              {perm === "granted" ? "On for this browser" : perm === "denied" ? "Blocked. Allow notifications for this site in your browser settings." : perm === "unsupported" ? "This browser can't show notifications." : "Off for this browser"}
            </div>
          </div>
          {perm === "default" && (
            <button className="btn sm primary" onClick={askNotify}>
              Turn on
            </button>
          )}
          {perm === "granted" && <span className="status done">On</span>}
        </div>
      </div>
      <div className="sect">You</div>
      <div className="group">
        <div className="it">
          <UserAv u={me} />
          <div className="grow">
            <b style={{ fontWeight: 600 }}>{me.name}</b>
            <div className="small muted">
              {me.email} · {me.role.charAt(0).toUpperCase() + me.role.slice(1)}
            </div>
          </div>
          <button className="btn sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>
      {me.role === "owner" && !hosted && <YourData workspace={workspace} />}
    </div>
  );
}

// Owner only: download everything, or delete the workspace.
function YourData({ workspace }: { workspace: string }) {
  const { fail } = useStore();
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const erase = async () => {
    setBusy(true);
    try {
      await api.post("/api/workspace/delete", { confirm, password });
      location.href = "/";
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  return (
    <>
      <div className="sect">Your data</div>
      <div className="group">
        <div className="it">
          <span className="ic">
            <Icon n="file" />
          </span>
          <div className="grow">
            Download all data
            <div className="small muted">Chats, tasks, memory, agents and their files, as one .tar.gz file.</div>
          </div>
          <a className="btn sm" href="/api/workspace/export" download>
            Download
          </a>
        </div>
        <div className="it">
          <span className="ic danger">
            <Icon n="trash" />
          </span>
          <div className="grow">
            Delete workspace
            <div className="small muted">Removes every chat, agent, key and file on this server. This can't be undone.</div>
          </div>
          <button className="btn sm danger" onClick={() => setDeleting(true)}>
            Delete
          </button>
        </div>
      </div>
      {deleting && (
        <Modal
          title="Delete this workspace?"
          sub="Everything on this server goes. Download your data first if you want a copy."
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(false)}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy || confirm.trim() !== workspace || !password} onClick={erase}>
                Delete for good
              </button>
            </>
          }
        >
          <label className="small muted">
            Type <b>{workspace}</b> to confirm
          </label>
          <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Workspace name" style={{ marginBottom: 12 }} />
          <label className="small muted">Your password</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- engines
interface EngineInfo {
  id: string;
  name: string;
  vendor: string;
  description: string;
  protocol: string;
  image: string;
  installed: boolean;
  version: string;
  dockerfile: boolean;
  agents: string[];
  job: { state: "running" | "done" | "error"; log: string } | null;
  providerKinds: string[];
}
function Engines() {
  const { agent, isAdmin, fail, toast } = useStore();
  const [list, setList] = useState<EngineInfo[] | null>(null);
  const [showLog, setShowLog] = useState<string>("");
  const load = useCallback(
    () =>
      api
        .get("/api/engines")
        .then((r) => setList((r.engines as EngineInfo[]).filter((e) => !e.id.startsWith("mock"))))
        .catch(fail),
    [fail],
  );
  useEffect(() => {
    load();
  }, [load]);
  const running = list?.some((e) => e.job?.state === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [running, load]);
  const install = async (e: EngineInfo) => {
    try {
      await api.post(`/api/engines/${e.id}/install`);
      toast(`Installing ${e.name}. This can take a few minutes.`);
      setShowLog(e.id);
      load();
    } catch (x) {
      fail(x);
    }
  };
  return (
    <div className="page wide">
      <div className="row">
        <h2 className="h2">Engines</h2>
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={load}>
          <Icon n="refresh" size="sm" />
          Check again
        </button>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        Every agent is one of these CLI agents, running as a long-lived process in its own sandbox.
      </p>
      {!list && <div className="muted" style={{ marginTop: 20 }}>Checking…</div>}
      <div className="col" style={{ gap: 10, marginTop: 20 }}>
        {list?.map((e) => (
          <div key={e.id} className="group" style={{ padding: 16, opacity: e.installed ? 1 : 0.85 }}>
            <div className="row" style={{ gap: 14 }}>
              <EngIcon id={e.id} />
              <div className="grow">
                <b>{e.name}</b>{" "}
                <span className="small muted">
                  {e.installed ? (e.version ? `v${e.version.replace(/^v/, "")}` : "installed") : "not installed"} · {e.protocol === "acp" ? "ACP" : "ACP adapter"}
                </span>
                <div className="small muted">
                  {e.vendor} · {e.description}
                </div>
              </div>
              {e.agents.length > 0 && (
                <span className="stack">
                  {e.agents.slice(0, 5).map((id) => (
                    <AgentAv key={id} a={agent(id)} size={30} dot={false} />
                  ))}
                </span>
              )}
              {e.job?.state === "running" ? (
                <span className="status working">
                  <Icon n="refresh" />
                  Installing
                </span>
              ) : e.job?.state === "error" ? (
                <span className="status blocked">Install failed</span>
              ) : e.installed ? (
                <span className="status done">Installed</span>
              ) : (
                <span className="status sleeping">Not installed</span>
              )}
              {isAdmin && e.dockerfile && e.job?.state !== "running" && (
                <button className="btn sm" onClick={() => install(e)}>
                  {e.installed ? "Update" : "Install"}
                </button>
              )}
              {e.job && (
                <button className="btn sm ghost" onClick={() => setShowLog(showLog === e.id ? "" : e.id)}>
                  {showLog === e.id ? "Hide log" : "Log"}
                </button>
              )}
            </div>
            {showLog === e.id && e.job && <div className="joblog">{e.job.log || "Starting…"}</div>}
          </div>
        ))}
      </div>
      <div className="row small muted" style={{ gap: 8, marginTop: 16 }}>
        <Icon n="box" size="sm" />
        Installing builds a Docker image on this server. Docker must be running.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- models and keys
interface Provider {
  id: string;
  kind: "openai-compatible" | "anthropic" | "openai";
  baseUrl: string;
  models: string[];
  label: string;
  hasKey: boolean;
  /** hosted: "CircleChat models", paid by credits, can't be edited or removed */
  builtin?: boolean;
}
const KIND_NAMES: Record<Provider["kind"], string> = { "openai-compatible": "OpenAI compatible", anthropic: "Anthropic", openai: "OpenAI" };

function Models() {
  const { agent, isAdmin, fail, toast } = useStore();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [usage, setUsage] = useState<{ month: string; total: number; limitCents: number; byAgent: { agentId: string; tokens: number; costMicros: number }[] } | null>(null);
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [limit, setLimit] = useState("");
  const load = useCallback(() => {
    api
      .get("/api/providers")
      .then((r) => setProviders(r.providers))
      .catch(fail);
    api
      .get("/api/usage")
      .then((r) => {
        setUsage(r);
        setLimit(r.limitCents ? String(r.limitCents / 100) : "");
      })
      .catch(fail);
  }, [fail]);
  useEffect(() => {
    load();
  }, [load]);
  const test = async (p: Provider) => {
    setTests((t) => ({ ...t, [p.id]: { ok: true, detail: "Testing…" } }));
    try {
      const r = await api.post(`/api/providers/${p.id}/test`);
      setTests((t) => ({ ...t, [p.id]: { ok: r.ok, detail: r.ok ? `Works · ${r.detail}` : `Failed · ${r.detail}` } }));
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (p: Provider) => {
    if (!confirm(`Remove ${p.label || p.id}? Agents using it stop working until you pick another.`)) return;
    try {
      const r = await api.del(`/api/providers/${p.id}`);
      setProviders(r.providers);
    } catch (e) {
      fail(e);
    }
  };
  const saveLimit = async () => {
    try {
      await api.put("/api/settings", { monthlyLimitCents: Math.round(Number(limit || 0) * 100) });
      toast("Limit saved");
      load();
    } catch (e) {
      fail(e);
    }
  };
  const total = usage?.total ?? 0;
  const cap = (usage?.limitCents ?? 0) * 10_000;
  const max = Math.max(1, ...(usage?.byAgent ?? []).map((u) => u.costMicros));
  const resets = (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  })();
  return (
    <div className="page">
      <h2 className="h2">Models and keys</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        Keys are stored encrypted on this server. Agents never see them.
      </p>
      <div className="sect">Providers</div>
      <div className="group">
        {providers.length === 0 && <div className="it small muted">No providers yet. Add one so agents can use a model.</div>}
        {providers.map((p) => (
          <div key={p.id} className="it">
            <span className="ic" style={{ fontWeight: 700, fontSize: 13 }}>
              {p.baseUrl && /localhost|127\.0\.0\.1|:\d{4,5}/.test(p.baseUrl) ? <Icon n="server" /> : (p.label || p.id).charAt(0).toUpperCase()}
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              {p.builtin ? "CircleChat models" : p.label || p.id} <span className="small muted">{p.builtin ? "included credits" : KIND_NAMES[p.kind]}</span>
              <div className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.builtin
                  ? "Paid by your AI credits. Add your own key below to use your own models."
                  : `${p.hasKey ? "Key saved" : "No key"}${p.baseUrl ? ` · ${p.baseUrl}` : ""}${p.models.length ? ` · ${p.models.join(", ")}` : ""}`}
              </div>
              {tests[p.id] && <div className={tests[p.id].ok ? "ok-msg" : "err-msg"}>{tests[p.id].detail}</div>}
            </div>
            <button className="btn sm" onClick={() => test(p)}>
              Test
            </button>
            {p.builtin && <span className="small muted">Built in</span>}
            {isAdmin && !p.builtin && (
              <>
                <button className="btn sm" onClick={() => setEditing(p)}>
                  Edit
                </button>
                <button className="btn sm icon ghost" aria-label="Remove" onClick={() => remove(p)}>
                  <Icon n="trash" size="sm" />
                </button>
              </>
            )}
          </div>
        ))}
        {isAdmin && (
          <div className="it" style={{ color: "var(--accent)", fontWeight: 500, cursor: "pointer" }} onClick={() => setEditing("new")}>
            <span className="ic" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              <Icon n="plus" />
            </span>
            Add a provider or local model
          </div>
        )}
      </div>
      <div className="group" style={{ padding: 22, marginTop: 22 }}>
        <div className="small muted" style={{ fontWeight: 600 }}>
          Spent this month
        </div>
        <div className="big-n" style={{ fontSize: 36, marginTop: 2 }}>
          {dollars(total)}{" "}
          {cap > 0 && (
            <span className="muted" style={{ fontSize: 18, fontWeight: 500 }}>
              of ${(cap / 1e6).toFixed(0)} limit
            </span>
          )}
        </div>
        <div className="meter" style={{ marginTop: 14, height: 10 }}>
          <i style={{ width: `${cap ? Math.min(100, (total / cap) * 100) : 0}%`, background: cap && total >= cap ? "var(--blocked)" : undefined }} />
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>Resets {resets}</div>
      </div>
      <div className="sect">Who used what</div>
      <div className="group">
        {(usage?.byAgent ?? []).length === 0 && <div className="it small muted">Nothing used yet this month.</div>}
        {(usage?.byAgent ?? [])
          .slice()
          .sort((a, b) => b.costMicros - a.costMicros)
          .map((u) => {
            const a = agent(u.agentId);
            return (
              <div key={u.agentId} className="it">
                <AgentAv a={a} dot={false} size={38} />
                {a?.name ?? "Removed agent"}
                <span className="small muted">
                  {a ? `${a.engine}${a.model ? ` · ${a.model}` : ""}` : ""} · {u.tokens.toLocaleString()} tokens
                </span>
                <div className="grow" style={{ margin: "0 12px" }}>
                  <div className="meter" style={{ height: 6 }}>
                    <i style={{ width: `${(u.costMicros / max) * 100}%`, background: a ? COLOURS[a.colour]?.hex : undefined }} />
                  </div>
                </div>
                <span className="num">{dollars(u.costMicros)}</span>
              </div>
            );
          })}
      </div>
      <div className="sect">Limit</div>
      <div className="group">
        <div className="it">
          Monthly limit across all agents
          <span className="right" style={{ gap: 8 }}>
            <span>$</span>
            <input
              className="input sm"
              style={{ width: 100 }}
              inputMode="decimal"
              value={limit}
              placeholder="no limit"
              disabled={!isAdmin}
              onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ""))}
              aria-label="Monthly limit in dollars"
            />
            {isAdmin && (
              <button className="btn sm" onClick={saveLimit} disabled={Math.round(Number(limit || 0) * 100) === (usage?.limitCents ?? 0)}>
                Save
              </button>
            )}
          </span>
        </div>
        <div className="it small muted">When the limit is hit, agents stop and tell you. Each agent can also have its own budget on its profile.</div>
      </div>
      {editing && (
        <ProviderModal
          p={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            setProviders(list);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

export function ProviderModal({ p, onClose, onSaved }: { p: Provider | null; onClose: () => void; onSaved: (l: Provider[]) => void }) {
  const { fail, toast } = useStore();
  const [f, setF] = useState({
    id: p?.id ?? "",
    label: p?.label ?? "",
    kind: p?.kind ?? ("openai-compatible" as Provider["kind"]),
    baseUrl: p?.baseUrl ?? "",
    apiKey: "",
    models: (p?.models ?? []).join(", "),
  });
  const [busy, setBusy] = useState(false);
  const set = (x: Partial<typeof f>) => setF((y) => ({ ...y, ...x }));
  const save = async () => {
    setBusy(true);
    try {
      const id = (f.id || f.label).toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const body: any = { kind: f.kind, baseUrl: f.baseUrl, label: f.label || id, models: f.models.split(/[\s,]+/).filter(Boolean) };
      if (f.apiKey) body.apiKey = f.apiKey;
      const r = await api.put(`/api/providers/${id}`, body);
      toast("Saved");
      onSaved(r.providers);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const placeholderUrl = f.kind === "anthropic" ? "https://api.anthropic.com" : f.kind === "openai" ? "https://api.openai.com/v1" : "http://localhost:11434/v1";
  return (
    <Modal
      title={p ? `Edit ${p.label || p.id}` : "Add a provider"}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !(f.id || f.label).trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field-row">
          <div>
            <label className="label">Name</label>
            <input className="input sm" value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="OpenRouter" autoFocus />
          </div>
          <div>
            <label className="label">Kind</label>
            <select className="input sm" value={f.kind} onChange={(e) => set({ kind: e.target.value as Provider["kind"] })}>
              <option value="openai-compatible">OpenAI compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
        </div>
        {!p && (
          <div>
            <label className="label">ID</label>
            <input className="input sm mono" value={f.id} onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} placeholder={(f.label || "openrouter").toLowerCase().replace(/[^a-z0-9_-]/g, "")} />
          </div>
        )}
        <div>
          <label className="label">Base URL</label>
          <input className="input sm mono" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={placeholderUrl} />
          <div className="hint">Leave empty for the provider's usual address.</div>
        </div>
        <div>
          <label className="label">API key</label>
          <input className="input sm mono" type="password" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={p?.hasKey ? "Saved. Type to replace it." : "Not needed for most local models"} autoComplete="off" />
        </div>
        <div>
          <label className="label">Models</label>
          <input className="input sm mono" value={f.models} onChange={(e) => set({ models: e.target.value })} placeholder="anthropic/claude-sonnet-4.5, qwen3" />
          <div className="hint">Separate with commas. These show up as suggestions when you pick a model.</div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- slack bridge
interface Bridge {
  id: string;
  kind: string;
  chatId: string;
  channel: string;
  enabled: number;
  status: string;
  error: string;
}
function Slack() {
  const { chats, agent, chat, isAdmin, fail, toast } = useStore();
  const [list, setList] = useState<Bridge[]>([]);
  const [f, setF] = useState({ chatId: "", channel: "", botToken: "", appToken: "" });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api
        .get("/api/bridges")
        .then((r) => setList(r.bridges))
        .catch(fail),
    [fail],
  );
  useEffect(() => {
    load();
  }, [load]);
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post("/api/bridges", f);
      if (r.started) toast("Bridge is running");
      else toast(`Saved, but it didn't start: ${r.error}`, true);
      setAdding(false);
      setF({ chatId: "", channel: "", botToken: "", appToken: "" });
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="row">
        <h2 className="h2">Slack bridge</h2>
        {isAdmin && (
          <button className="btn primary sm" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>
            <Icon n="plus" size="sm" />
            Add a bridge
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        Mirror a chat and a Slack channel both ways. Uses a Slack app with Socket Mode.
      </p>
      <div className="sect">Bridges</div>
      <div className="group">
        {list.length === 0 && (
          <div className="it">
            <Empty icon="link">No bridges yet.</Empty>
          </div>
        )}
        {list.map((b) => {
          const c = chat(b.chatId);
          return (
            <div key={b.id} className="it">
              <span className="applogo" style={{ background: "#4A154B" }}>
                Sl
              </span>
              <div className="grow">
                {c ? chatTitle(c, agent) : "A chat"} <Icon n="handoff" size="sm" className="muted" /> <code>{b.channel}</code>
                {b.error && <div className="err-msg">{b.error}</div>}
              </div>
              <span className={`status ${b.status === "running" || b.status === "connected" ? "done" : b.status === "error" ? "blocked" : "sleeping"}`}>{b.status}</span>
            </div>
          );
        })}
      </div>
      {adding && (
        <Modal
          title="Add a Slack bridge"
          onClose={() => setAdding(false)}
          icon={
            <span className="applogo" style={{ background: "#4A154B" }}>
              Sl
            </span>
          }
          footer={
            <>
              <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !f.chatId || !f.channel || !f.botToken || !f.appToken} onClick={add}>
                Connect
              </button>
            </>
          }
        >
          <div className="form">
            <div>
              <label className="label">Chat</label>
              <select className="input sm" value={f.chatId} onChange={(e) => setF({ ...f, chatId: e.target.value })}>
                <option value="">Pick a chat</option>
                {chats
                  .filter((c) => c.kind !== "agents")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {chatTitle(c, agent)}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label">Slack channel ID</label>
              <input className="input sm mono" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} placeholder="C0123456789" />
            </div>
            <div>
              <label className="label">Bot token</label>
              <input className="input sm mono" type="password" value={f.botToken} onChange={(e) => setF({ ...f, botToken: e.target.value })} placeholder="xoxb-…" autoComplete="off" />
            </div>
            <div>
              <label className="label">App token</label>
              <input className="input sm mono" type="password" value={f.appToken} onChange={(e) => setF({ ...f, appToken: e.target.value })} placeholder="xapp-…" autoComplete="off" />
              <div className="hint">Both tokens go into the vault.</div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- hosting (CircleChat Cloud only)
interface HostingInfo {
  workspace: string;
  url: string;
  status: string;
  plan: string;
  planLabel: string;
  monthly: number;
  plans: { id: string; label: string; monthly: number; maxAgents: number; vcpu: number; memoryGb: number }[];
  trialEndsAt: string | null;
  region: string;
  customDomain: string | null;
  lastBackupAt: string | null;
  backups: { file: string; size: number }[];
  gateway: boolean;
  local: boolean;
  busy: string | null;
}

function Hosting() {
  const { fail, toast, workspace, go } = useStore();
  const [h, setH] = useState<HostingInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [domain, setDomain] = useState("");
  const [gw, setGw] = useState<{ email: string; password: string } | null>(null);
  const [del, setDel] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [gone, setGone] = useState(false);
  const load = useCallback(() => api.get<HostingInfo>("/api/hosting/").then(setH).catch(fail), [fail]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (path: string, ok: string, body: unknown = {}) => {
    setBusy(path);
    try {
      const r = await api.post<any>(`/api/hosting/${path}`, body);
      toast(ok);
      if (path !== "delete") load(); // after a delete there's nothing left to load
      return r;
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  };
  if (gone)
    return (
      <div className="page">
        <h2 className="h2">Workspace deleted</h2>
        <p className="muted" style={{ marginTop: 8 }}>Your server and its data are being deleted, and the subscription has stopped. You can close this tab.</p>
      </div>
    );
  if (!h) return <div className="page"><p className="muted">Loading…</p></div>;
  const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
  const toDate = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  // "18 Nov 2026" and "18 Nov, 13:00": short and the same everywhere
  const day = (s: string | null) => (s ? toDate(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "never");
  const when = (s: string | null) =>
    s ? toDate(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";
  const bigger = h.plans.filter((p) => p.monthly > h.monthly);
  return (
    <div className="page">
      <h2 className="h2">Hosting</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        {h.workspace} runs on its own server {h.local ? "on this computer (local mode)" : `in ${h.region}`}. Run by CircleChat Cloud.
      </p>

      <div className="sect">Plan and billing</div>
      <div className="group">
        <div className="it">
          <span className="ic"><Icon n="dollar" /></span>
          <div className="grow">
            {h.planLabel}, €{h.monthly} a month
            <div className="small muted">{h.trialEndsAt ? `Free trial until ${day(h.trialEndsAt)}` : "Billed monthly"}</div>
          </div>
          <button className="btn sm" disabled={!!busy} onClick={async () => { const r = await act("portal", "Opening billing"); if (r?.url) window.open(r.url, "_blank", "noopener"); }}>
            Payment and invoices
          </button>
        </div>
        {bigger.map((p) => (
          <div className="it" key={p.id}>
            <span className="ic"><Icon n="layers" /></span>
            <div className="grow">
              Move to {p.label}, €{p.monthly} a month
              <div className="small muted">Up to {p.maxAgents} agents, {p.vcpu} vCPU, {p.memoryGb} GB. The server restarts once.</div>
            </div>
            <button className="btn sm" disabled={!!busy || h.status !== "active"} onClick={() => act("plan", `Moving to ${p.label}`, { plan: p.id })}>Upgrade</button>
          </div>
        ))}
        {!bigger.length && <div className="it"><span className="grow small muted">You're on the biggest plan. To move to a smaller one, write to support@circlechat.co.</span></div>}
      </div>

      <div className="sect">Server</div>
      <div className="group">
        <div className="it">
          <span className="ic"><Icon n="server" /></span>
          <div className="grow">
            {h.busy ? `${h.busy}…` : h.status === "active" ? "Running" : h.status}
            <div className="small muted">{h.url.replace(/^https?:\/\//, "")}</div>
          </div>
          <button className="btn sm" disabled={!!busy || h.status !== "active"} onClick={() => act("restart", "Restarting")}>Restart</button>
          <button className="btn sm" disabled={!!busy || h.status !== "active"} onClick={() => act("upgrade", "Updating to the latest version")}>Update</button>
        </div>
      </div>

      <div className="sect">Backups</div>
      <div className="group">
        <div className="it">
          <span className="ic"><Icon n="layers" /></span>
          <div className="grow">
            Every night, the last 7 kept
            <div className="small muted">Last backup: {when(h.lastBackupAt)}</div>
          </div>
          <button className="btn sm" disabled={!!busy || h.status !== "active"} onClick={() => act("backup", "Backing up")}>Back up now</button>
        </div>
        {h.backups.map((b) => (
          <div className="it" key={b.file}>
            <span className="ic"><Icon n="file" /></span>
            <div className="grow">
              {b.file.replace(/\.(tar|sql)\.gz$/, "").replace("T", " ")}
              <div className="small muted">{kb(b.size)}</div>
            </div>
            <a className="btn sm" href={`/api/hosting/backups/${encodeURIComponent(b.file)}`} download>Download</a>
            <button className="btn sm" disabled={!!busy} onClick={() => window.confirm("Put the workspace back to this backup? Anything newer is lost.") && act("restore", "Restoring", { file: b.file })}>
              Restore
            </button>
          </div>
        ))}
      </div>

      <div className="sect">Custom domain</div>
      <div className="group">
        <div className="it">
          <span className="ic"><Icon n="globe" /></span>
          <div className="grow">
            {h.customDomain ? <>Also served at <b>{h.customDomain}</b></> : "Use your own domain"}
            <div className="small muted">Add a CNAME record pointing to {h.url.replace(/^https?:\/\//, "")} first. We set up HTTPS for it.</div>
          </div>
          {h.customDomain ? (
            <button className="btn sm" disabled={!!busy} onClick={() => act("domain", "Removing the domain", { domain: "" })}>Remove</button>
          ) : (
            <span className="right" style={{ gap: 8 }}>
              <input className="input sm" style={{ width: 200 }} placeholder="chat.example.com" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} aria-label="Custom domain" />
              <button className="btn sm" disabled={!!busy || !domain || h.local} onClick={() => act("domain", "Adding the domain", { domain })}>Add</button>
            </span>
          )}
        </div>
      </div>

      <div className="sect">AI credits</div>
      <div className="group">
        <div className="it">
          <span className="ic"><Icon n="zap" /></span>
          <div className="grow">
            CircleChat models, paid by credits
            <div className="small muted">Your plan includes credits every month. Top up or use your own keys any time.</div>
          </div>
          <button className="btn sm" onClick={() => go("/settings/credits")}>Credits</button>
        </div>
      </div>

      <div className="sect">Your data</div>
      <div className="group">
        <div className="it">
          <span className="ic"><Icon n="file" /></span>
          <div className="grow">
            Download all data
            <div className="small muted">Chats, tasks, memory, people, agents and their files, as one .tar.gz file.</div>
          </div>
          <a className="btn sm" href="/api/workspace/export" download>Download</a>
        </div>
        <div className="it">
          <span className="ic danger"><Icon n="trash" /></span>
          <div className="grow">
            Delete workspace
            <div className="small muted">Deletes the server, every chat, agent, key and file, and our backups, and stops the subscription. This can't be undone.</div>
          </div>
          <button className="btn sm danger" onClick={() => setDel(true)}>Delete</button>
        </div>
      </div>
      {del && (
        <Modal
          title="Delete this workspace?"
          sub="Download your data first if you want a copy."
          onClose={() => setDel(false)}
          footer={
            <>
              <button className="btn" onClick={() => setDel(false)}>Cancel</button>
              <button
                className="btn danger"
                disabled={!!busy || confirm.trim() !== workspace}
                onClick={async () => {
                  const r = await act("delete", "Deleting", { confirm });
                  if (r) setGone(true);
                }}
              >
                Delete for good
              </button>
            </>
          }
        >
          <label className="small muted">
            Type <b>{workspace}</b> to confirm
          </label>
          <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Workspace name" />
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- credits (CircleChat Cloud only)
export interface CreditsInfo {
  usedPct?: number;
  creditsPerEur?: number;
  monthlyCredits?: number;
  balanceEur: number;
  included: { grantEur: number; leftEur: number; usedEur: number; periodStart: string | null };
  topupEur: number;
  usage: { day: string; eur: number; pct?: number }[];
  packs: number[];
  plan: string;
  low: boolean;
  empty: boolean;
}

function Credits() {
  const { fail, toast } = useStore();
  const [c, setC] = useState<CreditsInfo | null>(null);
  const [busy, setBusy] = useState(0);
  const load = useCallback(() => api.get<CreditsInfo>("/api/hosting/credits").then(setC).catch(fail), [fail]);
  useEffect(() => {
    load();
    if (new URLSearchParams(location.search).get("topup") === "done") toast("Thanks. Your credits are added.");
  }, [load, toast]);
  const topup = async (pack: number) => {
    setBusy(pack);
    try {
      const r = await api.post<{ url: string }>("/api/hosting/credits/topup", { pack });
      location.href = r.url;
    } catch (e) {
      fail(e);
      setBusy(0);
    }
  };
  if (!c) return <div className="page"><p className="muted">Loading…</p></div>;
  const per = c.creditsPerEur ?? 100;
  const pool = c.included.usedEur + Math.max(c.balanceEur, 0);
  const used = c.usedPct ?? (pool > 0 ? (c.included.usedEur / pool) * 100 : c.empty ? 100 : 0);
  const level = used >= 90 ? "red" : used >= 80 ? "yellow" : "blue";
  const pctText = (n: number) => (n > 0 && n < 1 ? "<1%" : `${Math.round(n)}%`);
  const dayPct = (u: CreditsInfo["usage"][number]) => u.pct ?? (pool > 0 ? (u.eur / pool) * 100 : 0);
  const maxDay = Math.max(0.1, ...c.usage.map(dayPct));
  const n = (x: number) => x.toLocaleString();
  return (
    <div className="page">
      <h2 className="h2">Credits</h2>
      <p className="muted" style={{ marginTop: 4 }}>Agents on CircleChat models use AI credits. Your own keys in Models and keys don't.</p>
      {(c.low || c.empty) && (
        <div className="credit-alert" role="status">
          {c.empty ? "Credits are used up. Agents on CircleChat models will say so until you top up." : "Credits are running low."}
        </div>
      )}
      <div className="group" style={{ padding: 22, marginTop: 18 }}>
        <div className="small muted" style={{ fontWeight: 600 }}>Used this month</div>
        <div className="big-n" style={{ fontSize: 36, marginTop: 2 }}>{pctText(used)}</div>
        <div className={"credit-meter " + level} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)} aria-label="Credits used this month">
          <i style={{ width: `${Math.min(100, used)}%` }} />
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          {c.monthlyCredits ? `Your plan includes ${n(c.monthlyCredits)} credits a month. ` : ""}Included credits renew each billing month. Top-ups never expire.
        </div>
      </div>

      <div className="sect">Top up</div>
      <div className="packs">
        {c.packs.map((p) => (
          <button key={p} className="pack" disabled={!!busy} onClick={() => topup(p)}>
            <b>{n(p * per)} credits</b>
            <span>{busy === p ? "Opening…" : `€${p}`}</span>
          </button>
        ))}
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>One-time payment. Credits are added right after.</div>

      <div className="sect">Used per day</div>
      <div className="group">
        {c.usage.length === 0 && <div className="it small muted">Nothing used yet.</div>}
        {c.usage.map((u) => (
          <div className="it" key={u.day}>
            <span style={{ width: 110 }} className="small">{new Date(u.day + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
            <div className="meter grow" style={{ height: 6 }}><i style={{ width: `${(dayPct(u) / maxDay) * 100}%` }} /></div>
            <span className="small num" style={{ width: 70, textAlign: "right" }}>{pctText(dayPct(u))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
