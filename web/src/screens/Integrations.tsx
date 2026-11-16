// SPDX-License-Identifier: AGPL-3.0-only
// Integrations (shown in Settings): connected apps, MCP servers, triggers and the tool log.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Grant } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { AgentAv, Empty, Filters, Icon, Modal, Seg, Toggle, Tri, shortWhen, hhmm, dollars, type Decision } from "../ui/ui.tsx";
import { ChatAvatar, MemberChip, argsSummary, chatTitle } from "./Chats.tsx";


// ---------------------------------------------------------------- shared: grants + policy editors
export function GrantsEditor({ value, onChange }: { value: Grant[]; onChange: (g: Grant[]) => void }) {
  const { chats, agents, agent } = useStore();
  const everyone = value.some((g) => g.type === "workspace");
  const has = (type: "chat" | "agent", id: string) => value.some((g) => g.type === type && g.id === id);
  const flip = (type: "chat" | "agent", id: string) => onChange(has(type, id) ? value.filter((g) => !(g.type === type && g.id === id)) : [...value, { type, id }]);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 12 }}>
        <span className="grow">
          Everywhere in the workspace
          <div className="small muted">Every agent in every chat can use it</div>
        </span>
        <Toggle on={everyone} onChange={(v) => onChange(v ? [...value.filter((g) => g.type !== "workspace"), { type: "workspace" }] : value.filter((g) => g.type !== "workspace"))} label="Everywhere" />
      </div>
      {!everyone && (
        <>
          <div>
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>
              In these chats
            </div>
            <div className="pickbox">
              {chats
                .filter((c) => c.kind !== "agents")
                .map((c) => (
                  <span key={c.id} className={"chip" + (has("chat", c.id) ? " on" : "")} onClick={() => flip("chat", c.id)}>
                    <ChatAvatar c={c} size={28} />
                    {chatTitle(c, agent)}
                    {has("chat", c.id) && <Icon n="check" size="sm" />}
                  </span>
                ))}
            </div>
          </div>
          <div>
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>
              For these agents, anywhere
            </div>
            <div className="pickbox">
              {agents.map((a) => (
                <MemberChip key={a.id} m={{ type: "agent", id: a.id }} on={has("agent", a.id)} onClick={() => flip("agent", a.id)} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function grantSummary(g: Grant[], name: (t: string, id: string) => string): string {
  if (g.some((x) => x.type === "workspace")) return "Everywhere";
  if (!g.length) return "Off everywhere";
  return g.map((x) => name(x.type, x.id ?? "")).join(", ");
}
function useGrantName() {
  const { chat, agent } = useStore();
  return (t: string, id: string) => (t === "chat" ? (chat(id) ? chatTitle(chat(id)!, agent) : "a chat") : (agent(id)?.name ?? "an agent"));
}

const GH_TOOLS: [string, string, Decision][] = [
  ["github_list_issues", "List issues", "allow"],
  ["github_get_issue", "Read an issue", "allow"],
  ["github_create_issue", "Open an issue", "ask"],
  ["github_comment", "Comment", "ask"],
  ["github_create_pull_request", "Open a pull request", "ask"],
  ["github_merge_pull_request", "Merge a pull request", "block"],
  ["github_delete_branch", "Delete a branch", "block"],
];
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 30) || "app"
  );
}
function connTools(c: { app: string; name: string }): [string, string, Decision][] {
  if (c.app === "github") return GH_TOOLS;
  const s = slug(c.name);
  return [
    [`${s}_get`, "GET (read)", "allow"],
    [`${s}_post`, "POST", "ask"],
    [`${s}_put`, "PUT", "ask"],
    [`${s}_patch`, "PATCH", "ask"],
    [`${s}_delete`, "DELETE", "block"],
  ];
}
function PolicyEditor({ tools, value, onChange }: { tools: [string, string, Decision][]; value: Record<string, Decision>; onChange: (v: Record<string, Decision>) => void }) {
  return (
    <div className="group">
      {tools.map(([t, label, def]) => (
        <div key={t} className="it" style={{ padding: "10px 14px" }}>
          <div className="grow">
            {label}
            <div>
              <code className="tool" style={{ fontSize: 11.5 }}>
                {t}
              </code>
            </div>
          </div>
          <Tri value={value[t] ?? def} onChange={(d) => onChange({ ...value, [t]: d })} />
        </div>
      ))}
    </div>
  );
}

// ================================================================ apps
interface Connection {
  id: string;
  app: "github" | "http";
  name: string;
  identity: "agent" | "user";
  ownerUserId: string;
  hasSecret: boolean;
  config: any;
  status: string;
  createdAt: number;
  grants: Grant[];
  policies: Record<string, Decision>;
}

function AppLogo({ app, preset, size = 40 }: { app: string; preset?: string; size?: number }) {
  const id = preset || (app === "github" ? "github" : "");
  if (id)
    return (
      <span className="applogo img" style={{ width: size, height: size }}>
        <img src={`/apps/${id}.svg`} alt="" width={Math.round(size * 0.55)} height={Math.round(size * 0.55)} />
      </span>
    );
  return (
    <span className="applogo" style={{ background: "#4A4F7A", width: size, height: size }}>
      <Icon n="globe" size="sm" />
    </span>
  );
}

interface CatalogApp {
  id: string;
  name: string;
  category: string;
  blurb: string;
  fields: { key: string; label: string; placeholder: string; hint?: string }[];
  secretLabel: string;
  secretPlaceholder: string;
  howTo: string;
  howToUrl: string;
}
const CATEGORY_ORDER = ["Code", "Chat", "Projects and docs", "Sales and support", "Payments and shops", "Email and texts"];
const GITHUB_TILE: CatalogApp = {
  id: "github",
  name: "GitHub",
  category: "Code",
  blurb: "Issues, pull requests and repos",
  fields: [],
  secretLabel: "Token",
  secretPlaceholder: "github_pat_…",
  howTo: "",
  howToUrl: "",
};

export function Apps() {
  const { fail, toast, user, me, isBuilder } = useStore();
  const gname = useGrantName();
  const [list, setList] = useState<Connection[]>([]);
  const [connect, setConnect] = useState<false | "github" | "http">(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<CatalogApp | null>(null);
  useEffect(() => {
    api
      .get("/api/apps/catalog")
      .then((r) => setCatalog(r.apps))
      .catch(() => {});
  }, []);
  const load = useCallback(
    () =>
      api
        .get("/api/connections")
        .then((r) => setList(r.connections))
        .catch(fail),
    [fail],
  );
  useEffect(() => {
    load();
  }, [load]);
  const test = async (c: Connection) => {
    try {
      const r = await api.post(`/api/connections/${c.id}/test`);
      setTests((t) => ({ ...t, [c.id]: r }));
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (c: Connection) => {
    if (!confirm(`Remove ${c.name}? Agents lose access right away.`)) return;
    try {
      await api.del(`/api/connections/${c.id}`);
      toast("Removed");
      load();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="page wide">
      <div className="row">
        <h2 className="h2">Apps</h2>
        {isBuilder && (
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setConnect("http")}>
            <Icon n="globe" size="sm" />
            Any other API
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        Connect the tools your team uses. Tokens stay in this server's vault. Agents use them through the gateway and never see them.
      </p>
      {list.length > 0 && <div className="sect">Connected</div>}
      <div className="col" style={{ gap: 10 }}>
        {list.map((c) => {
          const tr = tests[c.id];
          const pol = connTools(c);
          const asks = pol.filter(([t, , d]) => (c.policies[t] ?? d) === "ask").length;
          const blocks = pol.filter(([t, , d]) => (c.policies[t] ?? d) === "block").length;
          return (
            <div key={c.id} className="appcard">
              <AppLogo app={c.app} preset={c.config.preset} />
              <div className="grow">
                <b>{c.name}</b>{" "}
                <span className="small muted">
                  {c.app === "github" ? `GitHub${c.config.repos?.length ? ` · ${c.config.repos.join(", ")}` : ""}` : c.config.preset ? new URL(c.config.baseUrl).host : c.config.baseUrl}
                </span>
                <div className="small muted">
                  as <b>{c.identity === "user" ? (c.ownerUserId === me.id ? "you" : (user(c.ownerUserId)?.name ?? "a person")) : "agents"}</b>
                  {c.identity === "user" ? " · only on their own requests" : ""} · {grantSummary(c.grants, gname)}
                </div>
                <div className="badges">
                  <span className="rb r">Read</span>
                  {asks > 0 && <span className="rb w">{asks} ask first</span>}
                  {blocks > 0 && <span className="rb x">{blocks} blocked</span>}
                  {!c.hasSecret && <span className="rb w">No token</span>}
                </div>
                {tr && <div className={tr.ok ? "ok-msg" : "err-msg"} style={{ marginTop: 6 }}>{tr.detail}</div>}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={() => test(c)}>
                  Test
                </button>
                {isBuilder && (
                  <button className="btn sm" onClick={() => setEditing(c)}>
                    Access
                  </button>
                )}
                {isBuilder && (
                  <button className="btn sm icon ghost" aria-label="Remove" title="Remove" onClick={() => remove(c)}>
                    <Icon n="trash" size="sm" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="row" style={{ marginTop: 26, gap: 12 }}>
        <div className="sect" style={{ margin: 0 }}>All apps</div>
        <input className="input sm app-search" style={{ marginLeft: "auto", maxWidth: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps" aria-label="Search apps" />
      </div>
      {CATEGORY_ORDER.map((cat) => {
        const apps = [GITHUB_TILE, ...catalog].filter(
          (a) => a.category === cat && (!q.trim() || (a.name + " " + a.blurb).toLowerCase().includes(q.trim().toLowerCase())),
        );
        if (!apps.length) return null;
        return (
          <div key={cat}>
            <div className="small muted" style={{ fontWeight: 600, margin: "16px 0 8px" }}>
              {cat}
            </div>
            <div className="app-grid">
              {apps.map((a) => {
                const has = list.some((c) => (a.id === "github" ? c.app === "github" : c.config.preset === a.id));
                return (
                  <div key={a.id} className="app-tile">
                    <AppLogo app={a.id === "github" ? "github" : "http"} preset={a.id === "github" ? undefined : a.id} size={36} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <b>{a.name}</b>
                      <div className="small muted ellip">{a.blurb}</div>
                    </div>
                    {has ? (
                      <span className="small muted row" style={{ gap: 4 }}>
                        <Icon n="check" size="sm" />
                        Connected
                      </span>
                    ) : (
                      isBuilder && (
                        <button className="btn xs" onClick={() => (a.id === "github" ? setConnect("github") : setPick(a))}>
                          Connect
                        </button>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {pick && (
        <PresetModal
          app={pick}
          onClose={() => setPick(null)}
          onCreated={(c) => {
            setPick(null);
            load();
            setEditing(c);
          }}
        />
      )}
      {connect && (
        <ConnectModal
          initial={connect}
          onClose={() => setConnect(false)}
          onCreated={(c) => {
            setConnect(false);
            load();
            setEditing(c);
          }}
        />
      )}
      {editing && (
        <AccessModal
          c={editing}
          onClose={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PresetModal({ app, onClose, onCreated }: { app: CatalogApp; onClose: () => void; onCreated: (c: Connection) => void }) {
  const { toast } = useStore();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState("");
  const [identity, setIdentity] = useState<"agent" | "user">("agent");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ready = secret.trim() && app.fields.every((f) => (fields[f.key] ?? "").trim());
  const connect = async () => {
    setBusy(true);
    setErr("");
    let created: Connection | null = null;
    try {
      created = (await api.post("/api/connections", { preset: app.id, name: app.name, identity, secret: secret.trim(), fields })).connection as Connection;
      // check the token works before handing over; if it doesn't, nothing is kept
      const t = await api.post<{ ok: boolean; detail: string }>(`/api/connections/${created.id}/test`);
      if (!t.ok) {
        await api.del(`/api/connections/${created.id}`).catch(() => {});
        setErr(t.detail);
        return;
      }
      toast(`${t.detail}. Now choose who can use it.`);
      onCreated(created);
    } catch (e) {
      if (created) await api.del(`/api/connections/${created.id}`).catch(() => {});
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const radio = (on: boolean, title: string, sub: string, onClick: () => void) => (
    <div className="row" style={{ padding: "10px 14px", borderRadius: 14, cursor: "pointer", ...(on ? { boxShadow: "inset 0 0 0 2px var(--ink)" } : { background: "var(--bg)" }) }} onClick={onClick}>
      <span className={"radio" + (on ? " on" : "")} />
      <div className="grow">
        <b>{title}</b>
        <div className="small muted">{sub}</div>
      </div>
    </div>
  );
  return (
    <Modal
      title={`Connect ${app.name}`}
      sub={app.blurb}
      icon={<AppLogo app="http" preset={app.id} />}
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="small muted grow row" style={{ gap: 8 }}>
            <Icon n="lock" size="sm" />
            The token stays in the vault.
          </span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !ready} onClick={connect}>
            {busy ? "Checking…" : "Connect"}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="howto">
          <b>Get a token</b>
          <p>{app.howTo}</p>
          <a href={app.howToUrl} target="_blank" rel="noopener noreferrer">
            Open {app.name}
            <Icon n="arrow" size="sm" />
          </a>
        </div>
        {app.fields.map((f) => (
          <div key={f.key}>
            <label className="label">{f.label}</label>
            <input className="input sm" value={fields[f.key] ?? ""} onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.value }))} placeholder={f.placeholder} autoComplete="off" />
            {f.hint && <div className="hint">{f.hint}</div>}
          </div>
        ))}
        <div>
          <label className="label">{app.secretLabel}</label>
          <input
            className="input sm mono"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={app.secretPlaceholder}
            autoComplete="off"
            autoFocus={!app.fields.length}
            onKeyDown={(e) => e.key === "Enter" && ready && !busy && connect()}
          />
        </div>
        <div>
          <label className="label">Agents act as</label>
          <div className="col" style={{ gap: 8 }}>
            {radio(identity === "agent", "Their own account", "A bot or service token. Recommended.", () => setIdentity("agent"))}
            {radio(identity === "user", "You", "Only when you ask an agent yourself.", () => setIdentity("user"))}
          </div>
        </div>
        {err && <div className="err-msg">{err}</div>}
      </div>
    </Modal>
  );
}

function ConnectModal({ initial = "github", onClose, onCreated }: { initial?: "github" | "http"; onClose: () => void; onCreated: (c: Connection) => void }) {
  const { fail, toast } = useStore();
  const [f, setF] = useState({ app: initial as "github" | "http", name: initial === "github" ? "GitHub" : "", identity: "agent" as "agent" | "user", secret: "", repos: "", baseUrl: "", authHeader: "Authorization", authScheme: "Bearer " });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const create = async () => {
    setBusy(true);
    try {
      const body: any = { app: f.app, name: f.name, identity: f.identity, secret: f.secret || undefined };
      if (f.app === "github") body.repos = f.repos.split(/[\s,]+/).filter(Boolean);
      else Object.assign(body, { baseUrl: f.baseUrl, authHeader: f.authHeader, authScheme: f.authScheme });
      const r = await api.post("/api/connections", body);
      toast(`${f.name} connected. Now choose who can use it.`);
      onCreated(r.connection);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const radio = (on: boolean, title: string, sub: string, onClick: () => void, tag?: string) => (
    <div className="row" style={{ padding: "12px 14px", borderRadius: 14, cursor: "pointer", ...(on ? { boxShadow: "inset 0 0 0 2px var(--accent)", background: "var(--accent-soft)" } : { background: "var(--bg)" }) }} onClick={onClick}>
      <span className={"radio" + (on ? " on" : "")} />
      <div className="grow">
        <b>{title}</b>
        {tag && (
          <span className="tag-agent" style={{ background: "#fff", marginLeft: 6 }}>
            {tag}
          </span>
        )}
        <div className="small muted">{sub}</div>
      </div>
    </div>
  );
  return (
    <Modal
      title={f.app === "github" ? "Connect GitHub" : "Connect an HTTP API"}
      sub="Step 1 of 2 · Details"
      icon={<AppLogo app={f.app} />}
      onClose={onClose}
      width={640}
      footer={
        <>
          <span className="small muted grow row" style={{ gap: 8 }}>
            <Icon n="lock" size="sm" />
            The token stays in the vault.
          </span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim() || (f.app === "http" && !f.baseUrl.trim())} onClick={create}>
            Next
          </button>
        </>
      }
    >
      <div className="form">
        <div>
          <label className="label">App</label>
          <Seg
            value={f.app}
            options={[
              ["github", "GitHub"],
              ["http", "Any HTTP API"],
            ]}
            onChange={(v) => set({ app: v, name: v === "github" ? "GitHub" : "" })}
          />
        </div>
        <div>
          <label className="label">Name</label>
          <input className="input sm" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={f.app === "http" ? "Billing API" : "GitHub"} />
          {f.app === "http" && f.name && (
            <div className="hint">
              Tools will be called <code>{slug(f.name)}_get</code>, <code>{slug(f.name)}_post</code> and so on.
            </div>
          )}
        </div>
        <div>
          <label className="label">Agents act as</label>
          <div className="col" style={{ gap: 8 }}>
            {radio(f.identity === "agent", "Their own account", "A bot or service token. Actions show it was an agent.", () => set({ identity: "agent" }), "Recommended")}
            {radio(f.identity === "user", "You", "Only when you ask an agent. Never on someone else's request.", () => set({ identity: "user" }))}
          </div>
        </div>
        <div>
          <label className="label">{f.app === "github" ? "Token" : "Secret or API key"}</label>
          <input className="input sm mono" type="password" value={f.secret} onChange={(e) => set({ secret: e.target.value })} placeholder={f.app === "github" ? "github_pat_…" : "optional"} autoComplete="off" />
        </div>
        {f.app === "github" ? (
          <div>
            <label className="label">Repositories</label>
            <input className="input sm mono" value={f.repos} onChange={(e) => set({ repos: e.target.value })} placeholder="owner/site, owner/api" />
            <div className="hint">Agents can only touch these. Separate with commas.</div>
          </div>
        ) : (
          <>
            <div>
              <label className="label">Base URL</label>
              <input className="input sm mono" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
            </div>
            <div className="field-row">
              <div>
                <label className="label">Auth header</label>
                <input className="input sm mono" value={f.authHeader} onChange={(e) => set({ authHeader: e.target.value })} />
              </div>
              <div>
                <label className="label">Prefix</label>
                <input className="input sm mono" value={f.authScheme} onChange={(e) => set({ authScheme: e.target.value })} placeholder="Bearer " />
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function AccessModal({ c, onClose }: { c: Connection; onClose: () => void }) {
  const { fail, toast } = useStore();
  const [grants, setGrants] = useState<Grant[]>(c.grants);
  const [pol, setPol] = useState<Record<string, Decision>>(c.policies);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/connections/${c.id}/grants`, { grants });
      const tools = connTools(c);
      await api.put(`/api/connections/${c.id}/policies`, { policies: Object.fromEntries(tools.map(([t, , d]) => [t, pol[t] ?? d])) });
      toast("Access saved");
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${c.name}: access`}
      sub="Step 2 of 2 · New connections are off everywhere until you choose"
      icon={<AppLogo app={c.app} />}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <label className="label">Who can use it</label>
      {c.identity === "user" ? <div className="small muted" style={{ marginBottom: 8 }}>It acts as you, so it only works when you ask an agent yourself.</div> : null}
      <GrantsEditor value={grants} onChange={setGrants} />
      <label className="label" style={{ marginTop: 20 }}>
        What agents may do
      </label>
      <PolicyEditor tools={connTools(c)} value={pol} onChange={setPol} />
    </Modal>
  );
}

// ================================================================ MCP servers
interface McpServer {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url: string;
  command: string;
  args: string[];
  secrets: string[];
  tools: { name: string; description: string }[];
  status: string;
  error: string;
  grants: Grant[];
  policies: Record<string, Decision>;
}
const mcpToolKey = (s: McpServer, t: string) => `${s.name}__${t}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

export function McpServers({ id }: { id?: string }) {
  const { fail, go, toast, isBuilder } = useStore();
  const gname = useGrantName();
  const [list, setList] = useState<McpServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const load = useCallback(
    () =>
      api
        .get("/api/mcp")
        .then((r) => setList(r.servers))
        .catch(fail),
    [fail],
  );
  useEffect(() => {
    load();
  }, [load]);
  const s = list.find((x) => x.id === id);
  useEffect(() => setGrants(null), [id]);

  const setPolicy = async (tool: string, d: Decision) => {
    if (!s) return;
    try {
      const r = await api.put(`/api/mcp/${s.id}/policies`, { policies: { [mcpToolKey(s, tool)]: d } });
      setList((l) => l.map((x) => (x.id === s.id ? r.server : x)));
    } catch (e) {
      fail(e);
    }
  };
  const refresh = async () => {
    if (!s) return;
    try {
      const r = await api.post(`/api/mcp/${s.id}/refresh`);
      setList((l) => l.map((x) => (x.id === s.id ? r.server : x)));
      toast(r.added?.length ? `${r.added.length} new ${r.added.length === 1 ? "tool" : "tools"}, switched off until reviewed` : `Refreshed. ${r.tools.length} tools.`);
    } catch (e) {
      fail(e);
      load();
    }
  };
  const remove = async () => {
    if (!s || !confirm(`Remove ${s.name}?`)) return;
    try {
      await api.del(`/api/mcp/${s.id}`);
      go("/settings/mcp");
      load();
    } catch (e) {
      fail(e);
    }
  };
  const saveGrants = async () => {
    if (!s || !grants) return;
    try {
      const r = await api.put(`/api/mcp/${s.id}/grants`, { grants });
      setList((l) => l.map((x) => (x.id === s.id ? r.server : x)));
      setGrants(null);
      toast("Saved");
    } catch (e) {
      fail(e);
    }
  };

  if (!s)
    return (
      <div className="page wide">
        <div className="row">
          <h2 className="h2">MCP servers</h2>
          {isBuilder && (
            <button className="btn primary sm" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>
              <Icon n="plus" size="sm" />
              Add a server
            </button>
          )}
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          Bring any tool that speaks MCP. New tools stay off until someone reviews them.
        </p>
        <div className="col" style={{ gap: 10, marginTop: 20 }}>
          {list.length === 0 && (
            <div className="group" style={{ padding: 18 }}>
              <Empty icon="server">No MCP servers yet.</Empty>
            </div>
          )}
          {list.map((x) => {
            const off = x.tools.filter((t) => (x.policies[mcpToolKey(x, t.name)] ?? "off") === "off").length;
            return (
              <div key={x.id} className="group row" style={{ padding: "14px 16px", gap: 14, cursor: "pointer" }} onClick={() => go(`/settings/mcp/${x.id}`)}>
                <span className="ic" style={{ width: 40, height: 40, borderRadius: 12, background: "var(--bg)", display: "grid", placeItems: "center" }}>
                  <Icon n="server" />
                </span>
                <div className="grow">
                  <b>{x.name}</b>
                  <div className="small muted">
                    {x.transport === "http" ? x.url : `${x.command} ${x.args.join(" ")}`} · {x.tools.length} tools{off ? ` · ${off} off` : ""} · {grantSummary(x.grants, gname)}
                  </div>
                </div>
                <span className={`status ${x.status === "ok" ? "done" : x.status === "error" ? "blocked" : "sleeping"}`}>{x.status === "ok" ? "Running" : x.status === "error" ? "Error" : x.status}</span>
                <Icon n="right" size="sm" className="muted" />
              </div>
            );
          })}
        </div>
        {adding && (
          <AddMcpModal
            onClose={() => setAdding(false)}
            onDone={(sid) => {
              setAdding(false);
              load();
              go(`/settings/mcp/${sid}`);
            }}
          />
        )}
      </div>
    );

  return (
    <div className="page wide">
      <div className="row">
        <button className="btn icon ghost" aria-label="Back" onClick={() => go("/settings/mcp")}>
          <Icon n="left" />
        </button>
        <h2 className="h2">{s.name}</h2>
        <span className={`status ${s.status === "ok" ? "done" : "blocked"}`} style={{ marginLeft: 10 }}>
          {s.status === "ok" ? "Running" : "Error"}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn sm" onClick={refresh}>
            <Icon n="refresh" size="sm" />
            Refresh tools
          </button>
          {isBuilder && (
            <button className="btn sm ghost danger" onClick={remove}>
              <Icon n="trash" size="sm" />
              Remove
            </button>
          )}
        </span>
      </div>
      <div className="row small muted" style={{ gap: 14, marginTop: 6 }}>
        {s.transport === "http" ? (
          <span>
            Remote URL · <code>{s.url}</code>
          </span>
        ) : (
          <span>
            Local command · <code>{[s.command, ...s.args].join(" ")}</code>
          </span>
        )}
      </div>
      {s.error && (
        <div className="pill-c err" style={{ margin: "14px 0 0" }}>
          <Icon n="alert" size="sm" className="ic-sm" />
          {s.error}
        </div>
      )}
      {s.secrets.length > 0 && (
        <div className="group" style={{ marginTop: 18 }}>
          {s.secrets.map((k) => (
            <div key={k} className="it" style={{ padding: "10px 14px" }}>
              <span className="ic">
                <Icon n="key" />
              </span>
              <div className="grow">
                Secret: {k}
                <div className="small muted">Stored in the vault · given only to this server</div>
              </div>
              <span className="right">••••••••</span>
            </div>
          ))}
        </div>
      )}
      <div className="sect">Tools · new ones are off until reviewed</div>
      <div className="group">
        {s.tools.length === 0 && <div className="it small muted">No tools found. Try Refresh tools.</div>}
        {s.tools.map((t) => {
          const d = s.policies[mcpToolKey(s, t.name)] ?? "off";
          return (
            <div key={t.name} className="it" style={{ padding: "10px 14px", background: d === "off" ? "#FFFBF0" : undefined }}>
              <code className="tool">{t.name}</code>
              <span className="small muted grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {t.description}
              </span>
              <Tri value={d} withOff onChange={(v) => isBuilder && setPolicy(t.name, v)} />
            </div>
          );
        })}
      </div>
      <div className="sect">Who can use it</div>
      <div className="group" style={{ padding: 16 }}>
        <GrantsEditor value={grants ?? s.grants} onChange={setGrants} />
        {grants && (
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12, gap: 8 }}>
            <button className="btn sm ghost" onClick={() => setGrants(null)}>
              Undo
            </button>
            <button className="btn primary sm" onClick={saveGrants}>
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddMcpModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { fail, toast } = useStore();
  const [f, setF] = useState({ name: "", transport: "http" as "http" | "stdio", url: "", command: "", args: "", secrets: "" });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const add = async () => {
    setBusy(true);
    try {
      const secrets: Record<string, string> = {};
      for (const line of f.secrets.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) secrets[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const r = await api.post("/api/mcp", {
        name: f.name,
        transport: f.transport,
        url: f.transport === "http" ? f.url : undefined,
        command: f.transport === "stdio" ? f.command : undefined,
        args: f.transport === "stdio" ? (f.args.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, "")) : undefined,
        secrets,
      });
      if (r.refresh?.error) toast(`Added, but it didn't answer: ${r.refresh.error}`, true);
      else toast(`Added. ${r.server.tools.length} tools found, all off until reviewed.`);
      onDone(r.server.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add an MCP server"
      onClose={onClose}
      icon={
        <span className="ic" style={{ width: 40, height: 40, borderRadius: 12, background: "var(--bg)", display: "grid", placeItems: "center" }}>
          <Icon n="server" />
        </span>
      }
      footer={
        <>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim() || (f.transport === "http" ? !f.url.trim() : !f.command.trim())} onClick={add}>
            {busy ? "Connecting…" : "Add"}
          </button>
        </>
      }
    >
      <div className="form">
        <div>
          <label className="label">Name</label>
          <input className="input sm" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="postgres" autoFocus />
        </div>
        <div>
          <label className="label">How it connects</label>
          <Seg
            value={f.transport}
            options={[
              ["http", "Remote URL"],
              ["stdio", "Command"],
            ]}
            onChange={(v) => set({ transport: v })}
          />
        </div>
        {f.transport === "http" ? (
          <div>
            <label className="label">URL</label>
            <input className="input sm mono" value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" />
          </div>
        ) : (
          <div className="field-row">
            <div>
              <label className="label">Command</label>
              <input className="input sm mono" value={f.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
            </div>
            <div>
              <label className="label">Arguments</label>
              <input className="input sm mono" value={f.args} onChange={(e) => set({ args: e.target.value })} placeholder="-y @org/server --read-only" />
            </div>
          </div>
        )}
        <div>
          <label className="label">Secrets</label>
          <textarea className="input mono" style={{ minHeight: 70 }} value={f.secrets} onChange={(e) => set({ secrets: e.target.value })} placeholder={"DATABASE_URL=postgres://…"} />
          <div className="hint">One NAME=value per line. Stored in the vault and given only to this server.</div>
        </div>
      </div>
    </Modal>
  );
}

// ================================================================ triggers
interface Trigger {
  id: string;
  kind: "webhook" | "schedule";
  name: string;
  hasSecret: boolean;
  schedule: string;
  filter: Record<string, any>;
  chatId: string;
  agentId: string;
  prompt: string;
  enabled: boolean;
  url: string;
  runs: { id: string; status: string; summary: string; ts: number }[];
}

export function Triggers({ id }: { id?: string }) {
  const { fail, go, agent, chat, toast, isBuilder } = useStore();
  const [list, setList] = useState<Trigger[]>([]);
  const [runs, setRuns] = useState<Trigger["runs"]>([]);
  const [creating, setCreating] = useState(false);
  const load = useCallback(
    () =>
      api
        .get("/api/triggers")
        .then((r) => setList(r.triggers))
        .catch(fail),
    [fail],
  );
  useEffect(() => {
    load();
  }, [load]);
  const sel = list.find((t) => t.id === id) ?? list[0];
  const loadRuns = useCallback(() => {
    if (sel)
      api
        .get(`/api/triggers/${sel.id}/runs`)
        .then((r) => setRuns(r.runs))
        .catch(() => {});
  }, [sel?.id]);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);
  useBus((e) => {
    if (e.type === "message" && e.message.kind === "trigger") {
      load();
      loadRuns();
    }
  });
  const toggle = async (t: Trigger, enabled: boolean) => {
    try {
      await api.patch(`/api/triggers/${t.id}`, { enabled });
      load();
    } catch (e) {
      fail(e);
    }
  };
  const replay = async (rid: string) => {
    try {
      await api.post(`/api/trigger-runs/${rid}/replay`);
      toast(`Delivered again to ${agent(sel!.agentId)?.name ?? "the agent"}`);
      setTimeout(loadRuns, 300);
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (t: Trigger) => {
    if (!confirm(`Delete "${t.name}"?`)) return;
    try {
      await api.del(`/api/triggers/${t.id}`);
      go("/settings/triggers");
      load();
    } catch (e) {
      fail(e);
    }
  };
  const hookUrl = (t: Trigger) => `${location.origin}/hooks/${t.id}`;
  return (
    <div className="page wide">
      <div className="row">
        <h2 className="h2">Triggers</h2>
        {isBuilder && (
          <button className="btn primary sm" style={{ marginLeft: "auto" }} onClick={() => setCreating(true)}>
            <Icon n="plus" size="sm" />
            New trigger
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        Things outside CircleChat can wake an agent: webhooks and schedules.
      </p>
      <div className="col" style={{ gap: 10, marginTop: 20 }}>
        {list.length === 0 && (
          <div className="group" style={{ padding: 18 }}>
            <Empty icon="zap">No triggers yet.</Empty>
          </div>
        )}
        {list.map((t) => {
          const c = chat(t.chatId);
          return (
            <div
              key={t.id}
              className="group row"
              style={{ padding: "14px 16px", gap: 14, cursor: "pointer", boxShadow: sel?.id === t.id ? "inset 0 0 0 2px var(--accent)" : undefined }}
              onClick={() => go(`/settings/triggers/${t.id}`)}
            >
              <span className="ic" style={{ width: 40, height: 40, borderRadius: 12, background: "var(--bg)", display: "grid", placeItems: "center" }}>
                <Icon n={t.kind === "schedule" ? "calendar" : "zap"} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <b>{t.name}</b>
                <div className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.kind === "schedule" ? <code>{t.schedule}</code> : "Webhook"} → {c ? chatTitle(c, agent) : "a chat"} → <b>{agent(t.agentId)?.name ?? "agent"}</b> · "{t.prompt}"
                </div>
              </div>
              <span className="small muted">{t.runs.length ? `last ${shortWhen(t.runs[0].ts)}` : "never run"}</span>
              <span onClick={(e) => e.stopPropagation()}>
                <Toggle on={t.enabled} onChange={(v) => toggle(t, v)} disabled={!isBuilder} label="Enabled" />
              </span>
            </div>
          );
        })}
      </div>
      {sel && (
        <>
          {sel.kind === "webhook" && (
            <>
              <div className="sect">Webhook address for "{sel.name}"</div>
              <div className="group" style={{ padding: "12px 14px" }}>
                <div className="row" style={{ gap: 8 }}>
                  <code style={{ flex: 1, overflowWrap: "anywhere" }}>{hookUrl(sel)}</code>
                  <button
                    className="btn sm"
                    onClick={() => {
                      navigator.clipboard?.writeText(hookUrl(sel));
                      toast("Copied");
                    }}
                  >
                    Copy
                  </button>
                </div>
                <div className="small muted" style={{ marginTop: 8 }}>
                  POST JSON here.{" "}
                  {sel.hasSecret ? "Sign it with an X-Hub-Signature-256 header (GitHub style)." : "No secret set, so anyone with the address can call it."}
                  {Object.keys(sel.filter ?? {}).length ? ` Filter: ${JSON.stringify(sel.filter)}` : ""}
                </div>
              </div>
            </>
          )}
          <div className="sect row">
            <span className="grow">Last runs of "{sel.name}"</span>
            {isBuilder && (
              <button className="btn sm ghost danger" onClick={() => remove(sel)}>
                <Icon n="trash" size="sm" />
                Delete trigger
              </button>
            )}
          </div>
          <div className="group">
            {runs.length === 0 && <div className="it small muted">No runs yet.</div>}
            {runs.map((r) => (
              <div key={r.id} className="it" style={{ padding: "10px 14px" }}>
                <span className={`status ${r.status === "delivered" ? "done" : r.status === "skipped" ? "sleeping" : "blocked"}`}>{cap(r.status)}</span>
                <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.summary || "-"}
                </span>
                <AgentAv a={agent(sel.agentId)} size={28} dot={false} />
                <span className="small muted num">{shortWhen(r.ts)}</span>
                <button className="btn sm ghost" onClick={() => replay(r.id)}>
                  Replay
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {creating && (
        <NewTriggerModal
          onClose={() => setCreating(false)}
          onDone={(tid) => {
            setCreating(false);
            load();
            go(`/settings/triggers/${tid}`);
          }}
        />
      )}
    </div>
  );
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function NewTriggerModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { chats, agent, fail } = useStore();
  const [f, setF] = useState({ kind: "webhook" as "webhook" | "schedule", name: "", chatId: "", agentId: "", prompt: "", secret: "", filter: "", schedule: "30 8 * * 1-5" });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const c = chats.find((x) => x.id === f.chatId);
  const chatAgents = (c?.members ?? []).filter((m) => m.type === "agent");
  let filterErr = "";
  let filter: any = {};
  if (f.filter.trim())
    try {
      filter = JSON.parse(f.filter);
      if (typeof filter !== "object" || Array.isArray(filter)) filterErr = "The filter must be a JSON object";
    } catch {
      filterErr = "The filter isn't valid JSON";
    }
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post("/api/triggers", { ...f, filter, secret: f.kind === "webhook" ? f.secret : "", schedule: f.kind === "schedule" ? f.schedule : "" });
      onDone(r.trigger.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New trigger"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim() || !f.chatId || !f.agentId || !f.prompt.trim() || !!filterErr} onClick={create}>
            Create
          </button>
        </>
      }
    >
      <div className="form">
        <Seg
          value={f.kind}
          options={[
            ["webhook", "Webhook"],
            ["schedule", "Schedule"],
          ]}
          onChange={(v) => set({ kind: v })}
        />
        <div>
          <label className="label">Name</label>
          <input className="input sm" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={f.kind === "webhook" ? "New GitHub issue" : "Morning brief"} autoFocus />
        </div>
        <div className="field-row">
          <div>
            <label className="label">Chat</label>
            <select className="input sm" value={f.chatId} onChange={(e) => set({ chatId: e.target.value, agentId: "" })}>
              <option value="">Pick a chat</option>
              {chats
                .filter((x) => x.members.some((m) => m.type === "agent"))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {chatTitle(x, agent)}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="label">Agent</label>
            <select className="input sm" value={f.agentId} onChange={(e) => set({ agentId: e.target.value })} disabled={!c}>
              <option value="">{c ? "Pick an agent" : "Pick a chat first"}</option>
              {chatAgents.map((m) => (
                <option key={m.id} value={m.id}>
                  {agent(m.id)?.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {f.kind === "schedule" ? (
          <div>
            <label className="label">When</label>
            <input className="input sm mono" value={f.schedule} onChange={(e) => set({ schedule: e.target.value })} />
            <div className="hint">Cron, 5 fields: minute hour day month weekday. "30 8 * * 1-5" is weekdays at 08:30 server time.</div>
          </div>
        ) : (
          <>
            <div>
              <label className="label">Secret</label>
              <input className="input sm mono" value={f.secret} onChange={(e) => set({ secret: e.target.value })} placeholder="optional, checks the signature" autoComplete="off" />
            </div>
            <div>
              <label className="label">Only when</label>
              <textarea className="input mono" style={{ minHeight: 60 }} value={f.filter} onChange={(e) => set({ filter: e.target.value })} placeholder={'{"action": "opened", "issue.labels.*.name": "bug"}'} />
              {filterErr ? <div className="err-msg">{filterErr}</div> : <div className="hint">Optional JSON. Every field must match. Leave empty to run on every call.</div>}
            </div>
          </>
        )}
        <div>
          <label className="label">What to tell the agent</label>
          <textarea className="input" style={{ minHeight: 70 }} value={f.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder={f.kind === "webhook" ? "Look into {{issue.title}} ({{issue.html_url}}) and propose a fix" : "Send the morning brief"} />
          {f.kind === "webhook" && <div className="hint">Use {"{{path.to.field}}"} to pull values from the webhook body.</div>}
        </div>
      </div>
    </Modal>
  );
}

// ================================================================ tool log
interface Call {
  id: string;
  agentId: string;
  chatId: string;
  tool: string;
  args: any;
  asIdentity: string;
  approval: string;
  status: string;
  result: string;
  costMicros: number;
  ts: number;
}
export function ToolLog() {
  const { agents, agent, fail } = useStore();
  const [calls, setCalls] = useState<Call[]>([]);
  const [only, setOnly] = useState<"" | "approval" | "failed">("");
  const [who, setWho] = useState("");
  const [verify, setVerify] = useState<{ ok: boolean; [k: string]: any } | null>(null);
  const [open, setOpen] = useState<Call | null>(null);
  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (who) q.set("agent", who);
    if (only) q.set("only", only);
    api
      .get(`/api/toollog?${q}`)
      .then((r) => setCalls(r.calls))
      .catch(fail);
    api
      .get("/api/toollog/verify")
      .then(setVerify)
      .catch(() => setVerify(null));
  }, [who, only, fail]);
  useEffect(() => {
    load();
  }, [load]);
  const statusCls = (s: string) => (s === "ok" ? "done" : s === "pending" ? "waiting" : ["error", "blocked", "denied"].includes(s) ? "blocked" : "sleeping");
  const approvalCell = (c: Call): ReactNode => {
    if (!c.approval) return <span className="muted">-</span>;
    const cls = /blocked|denied|expired/.test(c.approval) ? "blocked" : /waiting/.test(c.approval) ? "waiting" : "idle";
    return <span className={`status ${cls}`}>{cap(c.approval)}</span>;
  };
  return (
    <div style={{ padding: "26px 28px" }}>
      <div className="row">
        <h2 className="h2">Tool log</h2>
        {verify &&
          (verify.ok ? (
            <span className="status done" style={{ marginLeft: 10 }} title={`${verify.count ?? ""} entries checked`}>
              <Icon n="shield" />
              Chain verified
            </span>
          ) : (
            <span className="status blocked" style={{ marginLeft: 10 }} title={JSON.stringify(verify)}>
              <Icon n="alert" />
              Chain broken{verify.brokenAt ? ` at ${verify.brokenAt}` : ""}
            </span>
          ))}
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={load}>
          <Icon n="refresh" size="sm" />
          Refresh
        </button>
      </div>
      <div className="row" style={{ gap: 10, padding: "14px 0 10px" }}>
        <Filters
          style={{ padding: 0 }}
          value={only}
          onChange={setOnly}
          options={[
            ["", "All calls"],
            ["approval", "Needed approval"],
            ["failed", "Failed or blocked"],
          ]}
        />
        <select className="input sm" style={{ width: 180, marginLeft: "auto" }} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Agent">
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      {calls.length === 0 ? (
        <Empty icon="list">No tool calls yet.</Empty>
      ) : (
        <table className="logt">
          <thead>
            <tr>
              <th>Time</th>
              <th>Agent</th>
              <th>Tool</th>
              <th>As</th>
              <th>Approval</th>
              <th>Result</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => {
              const a = agent(c.agentId);
              return (
                <tr key={c.id} className="click" onClick={() => setOpen(c)}>
                  <td className="num">
                    {shortWhen(c.ts) === hhmm(c.ts) ? hhmm(c.ts) : `${shortWhen(c.ts)} ${hhmm(c.ts)}`}
                  </td>
                  <td>
                    <AgentAv a={a} size={28} dot={false} /> {a?.name ?? "agent"}
                  </td>
                  <td>
                    <code className="tool">{c.tool}</code> <span className="args">{argsSummary(c.args)}</span>
                  </td>
                  <td>{c.asIdentity || <span className="muted">-</span>}</td>
                  <td>{approvalCell(c)}</td>
                  <td>
                    <span className={`status ${statusCls(c.status)}`}>{c.status === "ok" ? "OK" : cap(c.status)}</span>
                  </td>
                  <td className="num">{c.costMicros ? dollars(c.costMicros) : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {open && (
        <Modal title={open.tool} sub={`${agent(open.agentId)?.name ?? "agent"} · ${new Date(open.ts).toLocaleString()}`} onClose={() => setOpen(null)}>
          <label className="label">Arguments</label>
          <pre className="json">{JSON.stringify(open.args, null, 2)}</pre>
          <label className="label" style={{ marginTop: 14 }}>
            Result
          </label>
          <pre className="json">{open.result || "-"}</pre>
        </Modal>
      )}
    </div>
  );
}
