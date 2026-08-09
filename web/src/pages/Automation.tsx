import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Cable,
  Check,
  Clock3,
  Copy,
  Gauge,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Webhook,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { api, type AgentRow } from "../api/client";
import { useSpectator } from "../lib/hooks";

type Tab = "workflows" | "connectors" | "models";

type WorkflowRun = {
  id: string;
  workflowId: string;
  status: string;
  currentStateId: string | null;
  waitKind: string | null;
  startedAt: string;
  finishedAt: string | null;
};

type WebhookEndpoint = { id: string; name: string; url: string; active: boolean };
type Workflow = {
  id: string;
  name: string;
  description: string;
  status: string;
  triggerType: string;
  version: number;
  definitionJson: Record<string, unknown>;
  latestRuns: WorkflowRun[];
  endpoints: WebhookEndpoint[];
};

type Connector = {
  id: string;
  name: string;
  description: string;
  kind: "http" | "mcp";
  baseUrl: string;
  authType: string;
  status: string;
  hasSecret: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  grants: Array<{ agentId: string; scopes: string[] }>;
};

type ModelRoute = {
  tier: string;
  provider: string;
  model: string;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  cachedInputCostPerMtok: number;
  contextWindow: number | null;
  enabled: boolean;
};

type UsageRow = {
  provider: string;
  model: string;
  routeTier: string | null;
  source: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  events: number;
};

const APPROVAL_TEMPLATE = {
  start: "review",
  states: [
    {
      id: "review",
      type: "approval",
      name: "Human review",
      onSuccess: "cooldown",
      onFailure: "denied",
      config: { prompt: "Approve this workflow run?" },
    },
    { id: "cooldown", type: "wait", next: "done", config: { durationSeconds: 2 } },
    { id: "done", type: "terminal", config: { status: "completed", output: { approved: true } } },
    { id: "denied", type: "terminal", config: { status: "failed", error: "Denied by reviewer" } },
  ],
};

const WEBHOOK_TEMPLATE = {
  start: "durable_wait",
  states: [
    { id: "durable_wait", type: "wait", next: "done", config: { durationSeconds: 2 } },
    { id: "done", type: "terminal", config: { status: "completed", output: { accepted: true } } },
  ],
};

function ago(value: string | null): string {
  if (!value) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function usd(value: number): string {
  if (!value) return "$0";
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

function statusTone(status: string): string {
  if (["healthy", "completed", "active"].includes(status)) return "text-[var(--color-ok)]";
  if (["error", "failed", "disabled"].includes(status)) return "text-[var(--color-err)]";
  if (["waiting", "unchecked", "queued"].includes(status)) return "text-[var(--color-warn)]";
  return "text-[var(--color-muted)]";
}

export default function AutomationPage() {
  const [tab, setTab] = useState<Tab>("workflows");
  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2">
          <WorkflowIcon size={15} strokeWidth={2} /> Automation
        </div>
        <div className="ml-auto inline-flex gap-0.5 rounded-md border border-[var(--color-hair)] p-0.5">
          {(["workflows", "connectors", "models"] as Tab[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`px-3 py-1 text-[12px] rounded ${tab === value ? "bg-[var(--color-surface-2)] font-semibold" : "text-[var(--color-muted)]"}`}
              onClick={() => setTab(value)}
            >
              {value === "models" ? "Models & usage" : value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
        {tab === "workflows" && <WorkflowsPanel />}
        {tab === "connectors" && <ConnectorsPanel />}
        {tab === "models" && <ModelsPanel />}
      </div>
    </main>
  );
}

function WorkflowsPanel() {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("Webhook approval flow");
  const [description, setDescription] = useState("Signed event intake with a durable human and timer wait.");
  const [triggerType, setTriggerType] = useState<"manual" | "webhook">("webhook");
  const [definition, setDefinition] = useState(JSON.stringify(APPROVAL_TEMPLATE, null, 2));
  const [error, setError] = useState("");
  const [revealedSecret, setRevealedSecret] = useState<{ url: string; secret: string } | null>(null);
  const query = useQuery<{ workflows: Workflow[] }>({
    queryKey: ["automation", "workflows"],
    queryFn: () => api.get("/workflows"),
    refetchInterval: 3_000,
  });
  const create = useMutation({
    mutationFn: () =>
      api.post("/workflows", { name, description, triggerType, definition: JSON.parse(definition) }),
    onSuccess: () => {
      setCreating(false);
      setError("");
      qc.invalidateQueries({ queryKey: ["automation", "workflows"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const workflows = query.data?.workflows ?? [];
  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-[20px] font-semibold">Durable workflows</h1>
          <p className="mt-1 text-[13px] text-[var(--color-muted)] max-w-2xl">
            Persisted state machines for agent, connector, approval, timer, poll, and terminal steps. Every wake is replayable and every attempt is recorded.
          </p>
        </div>
        {!spectator && (
          <button className="btn sm ml-auto" type="button" onClick={() => setCreating((value) => !value)}>
            <Plus size={13} /> New workflow
          </button>
        )}
      </div>

      {creating && (
        <section className="mt-5 rounded-lg border border-[var(--color-hair)] bg-[var(--color-surface)] p-4">
          <div className="grid md:grid-cols-2 gap-3">
            <label className="text-[12px] text-[var(--color-muted)]">
              Name
              <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="text-[12px] text-[var(--color-muted)]">
              Trigger
              <select className="input mt-1 w-full" value={triggerType} onChange={(e) => setTriggerType(e.target.value as "manual" | "webhook")}>
                <option value="manual">Manual / API</option>
                <option value="webhook">Signed webhook</option>
              </select>
            </label>
          </div>
          <label className="block mt-3 text-[12px] text-[var(--color-muted)]">
            Description
            <input className="input mt-1 w-full" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="flex gap-2 mt-3">
            <button className="btn xs ghost" type="button" onClick={() => setDefinition(JSON.stringify(APPROVAL_TEMPLATE, null, 2))}>Approval + wait</button>
            <button className="btn xs ghost" type="button" onClick={() => setDefinition(JSON.stringify(WEBHOOK_TEMPLATE, null, 2))}>Webhook + wait</button>
          </div>
          <label className="block mt-3 text-[12px] text-[var(--color-muted)]">
            Workflow definition (advanced)
            <textarea
              className="input mt-1 w-full min-h-[260px] font-mono text-[11.5px] leading-5"
              value={definition}
              onChange={(e) => setDefinition(e.target.value)}
              spellCheck={false}
            />
          </label>
          {error && <p className="mt-2 text-[12px] text-[var(--color-err)]">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button className="btn sm" type="button" disabled={create.isPending} onClick={() => {
              try { JSON.parse(definition); setError(""); create.mutate(); }
              catch { setError("Definition must be valid JSON."); }
            }}>
              Create workflow
            </button>
            <button className="btn sm ghost" type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </section>
      )}

      {revealedSecret && (
        <section className="mt-4 rounded-lg border border-[var(--color-warn)] bg-[color-mix(in_srgb,var(--color-warn)_7%,transparent)] p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold"><KeyRound size={14} /> Copy this signing secret now</div>
          <p className="mt-1 text-[12px] text-[var(--color-muted)]">It is encrypted at rest and will not be shown again.</p>
          <CopyRow label="Endpoint" value={revealedSecret.url} />
          <CopyRow label="Secret" value={revealedSecret.secret} />
          <button className="btn xs ghost mt-2" onClick={() => setRevealedSecret(null)}>I saved it</button>
        </section>
      )}

      <div className="mt-5 grid gap-3">
        {query.isLoading && <Empty text="Loading workflows…" />}
        {!query.isLoading && workflows.length === 0 && <Empty text="No workflows yet. Start with the signed webhook template." />}
        {workflows.map((workflow) => (
          <WorkflowCard key={workflow.id} workflow={workflow} onSecret={setRevealedSecret} />
        ))}
      </div>
    </div>
  );
}

function WorkflowCard({ workflow, onSecret }: { workflow: Workflow; onSecret: (value: { url: string; secret: string }) => void }) {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const run = useMutation({
    mutationFn: () => api.post<{ runId: string }>(`/workflows/${workflow.id}/runs`, { input: { source: "automation-ui", at: new Date().toISOString() } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation", "workflows"] }),
  });
  const createHook = useMutation({
    mutationFn: () => api.post<{ endpoint: WebhookEndpoint; signingSecret: string }>(`/workflows/${workflow.id}/webhooks`, { name: `${workflow.name} inbound` }),
    onSuccess: (data) => {
      onSecret({ url: data.endpoint.url, secret: data.signingSecret });
      qc.invalidateQueries({ queryKey: ["automation", "workflows"] });
    },
  });
  const resume = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) => api.post(`/workflow-runs/${id}/resume`, { approved, output: { decidedFrom: "automation-ui" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation", "workflows"] }),
  });
  return (
    <section className="rounded-lg border border-[var(--color-hair)] bg-[var(--color-surface)] p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-md grid place-items-center bg-[var(--color-surface-2)] text-[var(--color-accent)]">
          {workflow.triggerType === "webhook" ? <Webhook size={17} /> : <WorkflowIcon size={17} />}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-[14px]">{workflow.name}</h2>
            <span className={`text-[10px] uppercase font-mono ${statusTone(workflow.status)}`}>{workflow.status}</span>
            <span className="text-[10px] text-[var(--color-muted-2)]">v{workflow.version}</span>
          </div>
          <p className="text-[12px] text-[var(--color-muted)] mt-0.5">{workflow.description || "No description"}</p>
        </div>
        {!spectator && (
          <div className="ml-auto flex gap-2">
            <button className="btn xs" type="button" disabled={run.isPending} onClick={() => run.mutate()}><Play size={12} /> Run</button>
            {workflow.triggerType === "webhook" && (
              <button className="btn xs ghost" type="button" disabled={createHook.isPending} onClick={() => createHook.mutate()}><KeyRound size={12} /> New endpoint</button>
            )}
          </div>
        )}
      </div>
      {workflow.endpoints.length > 0 && (
        <div className="mt-3 rounded-md bg-[var(--color-surface-2)] px-3 py-2">
          {workflow.endpoints.map((endpoint) => (
            <div key={endpoint.id} className="flex items-center gap-2 text-[11.5px]">
              <ShieldCheck size={12} className="text-[var(--color-ok)]" />
              <span>{endpoint.name}</span>
              <code className="truncate text-[var(--color-muted)]">{endpoint.url}</code>
              <button className="ml-auto" title="Copy endpoint" onClick={() => navigator.clipboard.writeText(endpoint.url)}><Copy size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="ana-table w-full">
          <thead><tr><th>Run</th><th>Status</th><th>State</th><th>Wait</th><th>Started</th><th /></tr></thead>
          <tbody>
            {workflow.latestRuns.slice(0, 5).map((item) => (
              <tr key={item.id}>
                <td className="font-mono text-[11px]">{item.id.slice(-8)}</td>
                <td className={`font-mono text-[11px] ${statusTone(item.status)}`}>{item.status}</td>
                <td className="font-mono text-[11px]">{item.currentStateId ?? "—"}</td>
                <td className="text-[11px]">{item.waitKind ?? "—"}</td>
                <td className="text-[11px] text-[var(--color-muted)]">{ago(item.startedAt)}</td>
                <td className="text-right">
                  {!spectator && item.status === "waiting" && item.waitKind === "human" && (
                    <span className="inline-flex gap-1">
                      <button className="btn xs" onClick={() => resume.mutate({ id: item.id, approved: true })}><Check size={11} /> Approve</button>
                      <button className="btn xs ghost" onClick={() => resume.mutate({ id: item.id, approved: false })}>Deny</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {workflow.latestRuns.length === 0 && <tr><td colSpan={6} className="text-[12px] text-[var(--color-muted)]">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConnectorsPanel() {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("Local HTTP service");
  const [kind, setKind] = useState<"http" | "mcp">("http");
  const [baseUrl, setBaseUrl] = useState("http://localhost:3000/health");
  const [authType, setAuthType] = useState("none");
  const [token, setToken] = useState("");
  const connectorsQ = useQuery<{ connectors: Connector[] }>({ queryKey: ["automation", "connectors"], queryFn: () => api.get("/connectors") });
  const agentsQ = useQuery<{ agents: AgentRow[] }>({ queryKey: ["agents"], queryFn: () => api.get("/agents") });
  const create = useMutation({
    mutationFn: () => api.post("/connectors", {
      name,
      kind,
      baseUrl,
      authType,
      ...(token ? { secret: authType === "oauth2" ? { clientSecret: token } : { bearerToken: token } } : {}),
    }),
    onSuccess: () => { setCreating(false); setToken(""); qc.invalidateQueries({ queryKey: ["automation", "connectors"] }); },
  });
  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-[20px] font-semibold">Connector & MCP registry</h1>
          <p className="mt-1 text-[13px] text-[var(--color-muted)] max-w-2xl">Workspace-scoped integrations with encrypted credentials, OAuth, health checks, and explicit per-agent grants.</p>
        </div>
        {!spectator && <button className="btn sm ml-auto" onClick={() => setCreating((v) => !v)}><Plus size={13} /> Add connector</button>}
      </div>
      {creating && (
        <section className="mt-5 rounded-lg border border-[var(--color-hair)] p-4">
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="Name"><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Kind"><select className="input w-full" value={kind} onChange={(e) => setKind(e.target.value as "http" | "mcp")}><option value="http">HTTP / REST</option><option value="mcp">MCP (HTTP JSON-RPC)</option></select></Field>
            <Field label="Base URL"><input className="input w-full" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
            <Field label="Authentication"><select className="input w-full" value={authType} onChange={(e) => setAuthType(e.target.value)}><option value="none">None</option><option value="bearer">Bearer token</option><option value="header">Custom headers</option><option value="oauth2">OAuth 2</option></select></Field>
            {authType !== "none" && <Field label={authType === "oauth2" ? "OAuth client secret" : "Token (encrypted)"}><input className="input w-full" type="password" value={token} onChange={(e) => setToken(e.target.value)} /></Field>}
          </div>
          {create.error && <p className="mt-2 text-[12px] text-[var(--color-err)]">{(create.error as Error).message}</p>}
          <div className="flex gap-2 mt-3"><button className="btn sm" onClick={() => create.mutate()} disabled={create.isPending}>Save connector</button><button className="btn sm ghost" onClick={() => setCreating(false)}>Cancel</button></div>
        </section>
      )}
      <div className="mt-5 grid md:grid-cols-2 gap-3">
        {connectorsQ.isLoading && <Empty text="Loading connectors…" />}
        {(connectorsQ.data?.connectors ?? []).map((connector) => (
          <ConnectorCard key={connector.id} connector={connector} agents={agentsQ.data?.agents ?? []} />
        ))}
        {!connectorsQ.isLoading && (connectorsQ.data?.connectors.length ?? 0) === 0 && <Empty text="No connectors installed." />}
      </div>
    </div>
  );
}

function ConnectorCard({ connector, agents }: { connector: Connector; agents: AgentRow[] }) {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  useEffect(() => { if (!agentId && agents[0]) setAgentId(agents[0].id); }, [agents, agentId]);
  const check = useMutation({ mutationFn: () => api.post(`/connectors/${connector.id}/check`), onSuccess: () => qc.invalidateQueries({ queryKey: ["automation", "connectors"] }) });
  const grant = useMutation({ mutationFn: () => api.put(`/connectors/${connector.id}/grants/${agentId}`, { scopes: ["tools.call"] }), onSuccess: () => qc.invalidateQueries({ queryKey: ["automation", "connectors"] }) });
  const oauth = useMutation({
    mutationFn: () => api.post<{ authorizationUrl: string }>(`/connectors/${connector.id}/oauth/start`),
    onSuccess: ({ authorizationUrl }) => { window.location.href = authorizationUrl; },
  });
  const handleByAgent = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.handle])), [agents]);
  return (
    <section className="rounded-lg border border-[var(--color-hair)] p-4 bg-[var(--color-surface)]">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-md grid place-items-center bg-[var(--color-surface-2)] text-[var(--color-accent)]">{connector.kind === "mcp" ? <Cable size={17} /> : <Webhook size={17} />}</div>
        <div className="min-w-0"><h2 className="font-semibold text-[14px]">{connector.name}</h2><p className="font-mono text-[11px] text-[var(--color-muted)] truncate">{connector.baseUrl}</p></div>
        <span className={`ml-auto text-[10px] uppercase font-mono ${statusTone(connector.status)}`}>{connector.status}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[var(--color-muted)]">
        <span>{connector.kind.toUpperCase()}</span><span>·</span><span>{connector.authType}</span><span>·</span><span>{connector.hasSecret ? "credential stored" : "no credential"}</span><span>·</span><span>checked {ago(connector.lastCheckedAt)}</span>
      </div>
      {connector.lastError && <p className="mt-2 text-[11px] text-[var(--color-err)] truncate" title={connector.lastError}>{connector.lastError}</p>}
      <div className="mt-3 text-[11px] text-[var(--color-muted)]">Granted to: {connector.grants.length ? connector.grants.map((g) => `@${handleByAgent.get(g.agentId) ?? g.agentId}`).join(", ") : "nobody"}</div>
      {!spectator && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn xs ghost" disabled={check.isPending} onClick={() => check.mutate()}><RefreshCw size={11} /> Check</button>
          {connector.authType === "oauth2" && <button className="btn xs ghost" onClick={() => oauth.mutate()}><KeyRound size={11} /> Connect OAuth</button>}
          {agents.length > 0 && <><select className="input h-7 text-[11px]" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.handle}</option>)}</select><button className="btn xs" disabled={!agentId || grant.isPending} onClick={() => grant.mutate()}><Bot size={11} /> Grant</button></>}
        </div>
      )}
    </section>
  );
}

function ModelsPanel() {
  const query = useQuery<{ tiers: string[]; routes: ModelRoute[]; usage: UsageRow[]; totals: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number; events: number; reportedEvents: number } }>({
    queryKey: ["automation", "models"], queryFn: () => api.get("/model-routing?days=30"),
  });
  const totals = query.data?.totals;
  return (
    <div className="max-w-6xl mx-auto">
      <div><h1 className="text-[20px] font-semibold">Model routing & real usage</h1><p className="mt-1 text-[13px] text-[var(--color-muted)] max-w-2xl">Choose a model for each workload tier. Runtimes receive the route recommendation and report provider usage; estimates remain visibly labelled as fallback.</p></div>
      <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric icon={<Activity size={14} />} label="Model calls" value={totals?.events ?? 0} />
        <Metric icon={<Gauge size={14} />} label="Input tokens" value={(totals?.inputTokens ?? 0).toLocaleString()} />
        <Metric icon={<Gauge size={14} />} label="Output tokens" value={(totals?.outputTokens ?? 0).toLocaleString()} />
        <Metric icon={<Clock3 size={14} />} label="30-day spend" value={usd(totals?.costUsd ?? 0)} />
      </div>
      <section className="mt-5 rounded-lg border border-[var(--color-hair)] overflow-hidden">
        {(query.data?.tiers ?? ["economy", "balanced", "frontier", "advisor"]).map((tier) => <ModelRouteRow key={tier} tier={tier} route={query.data?.routes.find((route) => route.tier === tier)} />)}
      </section>
      <section className="mt-6">
        <h2 className="ana-h">Usage by model (30 days)</h2>
        <div className="ana-table-wrap"><table className="ana-table w-full"><thead><tr><th>Provider / model</th><th>Tier</th><th>Source</th><th>Calls</th><th>Input</th><th>Output</th><th>Cached</th><th>Cost</th></tr></thead><tbody>
          {(query.data?.usage ?? []).map((row, index) => <tr key={`${row.provider}-${row.model}-${row.source}-${index}`}><td><span className="font-semibold">{row.provider}</span><span className="text-[var(--color-muted)]"> / {row.model}</span></td><td>{row.routeTier ?? "—"}</td><td><span className={row.source === "reported" ? "text-[var(--color-ok)]" : "text-[var(--color-warn)]"}>{row.source}</span></td><td className="ana-num">{row.events}</td><td className="ana-num">{row.inputTokens.toLocaleString()}</td><td className="ana-num">{row.outputTokens.toLocaleString()}</td><td className="ana-num">{row.cachedInputTokens.toLocaleString()}</td><td className="ana-num">{usd(row.costUsd)}</td></tr>)}
          {(query.data?.usage.length ?? 0) === 0 && <tr><td colSpan={8} className="text-[12px] text-[var(--color-muted)]">Usage will appear after the next agent run.</td></tr>}
        </tbody></table></div>
      </section>
    </div>
  );
}

function ModelRouteRow({ tier, route }: { tier: string; route?: ModelRoute }) {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const [provider, setProvider] = useState(route?.provider ?? "");
  const [model, setModel] = useState(route?.model ?? "");
  const [input, setInput] = useState(String(route?.inputCostPerMtok ?? 0));
  const [output, setOutput] = useState(String(route?.outputCostPerMtok ?? 0));
  const [cached, setCached] = useState(String(route?.cachedInputCostPerMtok ?? 0));
  useEffect(() => { if (route) { setProvider(route.provider); setModel(route.model); setInput(String(route.inputCostPerMtok)); setOutput(String(route.outputCostPerMtok)); setCached(String(route.cachedInputCostPerMtok)); } }, [route]);
  const save = useMutation({
    mutationFn: () => api.put(`/model-routing/${tier}`, { provider, model, inputCostPerMtok: Number(input), outputCostPerMtok: Number(output), cachedInputCostPerMtok: Number(cached), enabled: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation", "models"] }),
  });
  return <div className="grid grid-cols-[110px_1fr_1.5fr_repeat(3,100px)_70px] items-end gap-2 px-4 py-3 border-b last:border-b-0 border-[var(--color-hair)] overflow-x-auto">
    <div><div className="text-[12px] font-semibold capitalize">{tier}</div><div className="text-[10px] text-[var(--color-muted)]">routing tier</div></div>
    <Field label="Provider"><input aria-label={`${tier} provider`} className="input w-full" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="openai" /></Field>
    <Field label="Model"><input aria-label={`${tier} model`} className="input w-full" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" /></Field>
    <Field label="Input $/M"><input className="input w-full" type="number" min="0" value={input} onChange={(e) => setInput(e.target.value)} /></Field>
    <Field label="Output $/M"><input className="input w-full" type="number" min="0" value={output} onChange={(e) => setOutput(e.target.value)} /></Field>
    <Field label="Cached $/M"><input className="input w-full" type="number" min="0" value={cached} onChange={(e) => setCached(e.target.value)} /></Field>
    {!spectator && <button className="btn xs" disabled={!provider || !model || save.isPending} onClick={() => save.mutate()}>Save</button>}
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}<div className="mt-1 normal-case tracking-normal">{children}</div></label>; }
function Empty({ text }: { text: string }) { return <div className="rounded-lg border border-dashed border-[var(--color-hair)] p-8 text-center text-[13px] text-[var(--color-muted)]">{text}</div>; }
function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) { return <div className="ana-card"><div className="ana-card-top text-[var(--color-accent)]">{icon}<span>{label}</span></div><div className="ana-card-value">{value}</div></div>; }
function CopyRow({ label, value }: { label: string; value: string }) { const [copied, setCopied] = useState(false); return <div className="mt-2 flex items-center gap-2"><span className="w-16 text-[11px] text-[var(--color-muted)]">{label}</span><code className="flex-1 rounded bg-[var(--color-surface-2)] px-2 py-1.5 text-[11px] break-all">{value}</code><button className="btn xs ghost" onClick={() => navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}>{copied ? <Check size={11} /> : <Copy size={11} />}</button></div>; }
