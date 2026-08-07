import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Brain, ExternalLink, GitPullRequest, LayoutGrid, PackageOpen, Play, Plus, RefreshCw, ShieldCheck, Square, Users } from "lucide-react";
import { api } from "../api/client";
import { useConversations, useSpectator, useTasks } from "../lib/hooks";

type Tab = "memory" | "apps" | "git" | "stages" | "blueprints" | "runs" | "access";
type Decision = { id: string; kind: string; title: string; decision: string; rationale: string; alternativesJson: string[]; provenanceJson: Record<string, unknown>; source: string; status: string; createdAt: string };
type AppRow = { id: string; name: string; taskId: string; status: string; previewUrl: string; publicUrl: string; deployments: Array<{ id: string; status: string; healthStatus: string }>; logs: Array<{ id: string; event: string; message: string; createdAt: string }> };
type PrRoom = { id: string; provider: string; repository: string; prNumber: number; title: string; url: string; state: string; headRef: string; baseRef: string; diffJson: unknown[]; checksJson: unknown[]; reviewsJson: unknown[]; protectionJson: Record<string, unknown>; lastSyncedAt: string | null; lastError: string | null };
type Stage = { stage: string; title: string; position: number; instructions: string; entryRulesJson: Record<string, unknown>; exitRulesJson: Record<string, unknown>; agentId: string | null; skill: string | null; verification: string; escalationMemberId: string | null; nextStage: string | null };
type Blueprint = { id: string; name: string; description: string; version: number; definitionJson: { agents: unknown[]; skills: unknown[]; channels: unknown[]; workflows: unknown[] }; updatedAt: string };
type Connector = { id: string; name: string };
type Agent = { id: string; name: string; handle: string };

const tabs: Array<{ id: Tab; label: string; icon: typeof Brain }> = [
  { id: "memory", label: "Decisions", icon: Brain },
  { id: "apps", label: "Apps", icon: Boxes },
  { id: "git", label: "PR rooms", icon: GitPullRequest },
  { id: "stages", label: "Board stages", icon: LayoutGrid },
  { id: "blueprints", label: "Blueprints", icon: PackageOpen },
  { id: "runs", label: "Run control", icon: Play },
  { id: "access", label: "Access", icon: ShieldCheck },
];

export default function PlatformPage() {
  const [tab, setTab] = useState<Tab>("memory");
  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2"><Boxes size={15} /> Platform</div>
        <div className="ml-auto flex gap-1 overflow-auto">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`btn xs ghost inline-flex gap-1 ${tab === id ? "font-semibold bg-[var(--color-surface-2)]" : ""}`}>
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
        {tab === "memory" && <DecisionPanel />}
        {tab === "apps" && <AppsPanel />}
        {tab === "git" && <PrRoomsPanel />}
        {tab === "stages" && <StagesPanel />}
        {tab === "blueprints" && <BlueprintsPanel />}
        {tab === "runs" && <RunControlPanel />}
        {tab === "access" && <AccessPanel />}
      </div>
    </main>
  );
}

function SectionHead({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="flex items-start gap-4 max-w-6xl mx-auto mb-5"><div><h1 className="text-[20px] font-semibold">{title}</h1><p className="mt-1 text-[13px] text-[var(--color-muted)] max-w-3xl">{description}</p></div>{action && <div className="ml-auto">{action}</div>}</div>;
}

function DecisionPanel() {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ kind: "decision", title: "", decision: "", rationale: "", alternatives: "", provenance: "{}" });
  const query = useQuery<{ decisions: Decision[] }>({ queryKey: ["platform", "decisions"], queryFn: () => api.get("/decisions") });
  async function save(correctId?: string) {
    let provenance: Record<string, unknown>;
    try { provenance = JSON.parse(form.provenance); } catch { window.alert("Provenance must be valid JSON."); return; }
    await api.post(correctId ? `/decisions/${correctId}/correct` : "/decisions/observe", {
      kind: form.kind, title: form.title, decision: form.decision, rationale: form.rationale,
      alternatives: form.alternatives.split("\n").map((line) => line.trim()).filter(Boolean), provenance,
      source: correctId ? "human" : "observer",
    });
    setOpen(false); setForm({ kind: "decision", title: "", decision: "", rationale: "", alternatives: "", provenance: "{}" });
    await qc.invalidateQueries({ queryKey: ["platform", "decisions"] });
  }
  function correct(row: Decision) { setForm({ kind: row.kind, title: row.title, decision: row.decision, rationale: row.rationale, alternatives: row.alternativesJson.join("\n"), provenance: JSON.stringify(row.provenanceJson, null, 2) }); setOpen(true); setCorrection(row.id); }
  const [correction, setCorrection] = useState<string | undefined>();
  return <div><SectionHead title="Decision and precedent memory" description="An inspectable observer/reflector record of choices, alternatives, policies, exceptions, and steers. Corrections preserve the superseded record and its provenance." action={!spectator && <button className="btn sm" onClick={() => { setCorrection(undefined); setOpen((value) => !value); }}><Plus size={13} /> Record decision</button>} />
    {open && <div className="max-w-6xl mx-auto mb-5 border border-[var(--color-hair)] rounded-lg p-4 grid md:grid-cols-2 gap-3">
      <select className="input" aria-label="Decision type" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{["decision", "precedent", "policy", "exception", "steer"].map((value) => <option key={value}>{value}</option>)}</select>
      <input className="input" aria-label="Decision title" placeholder="Decision title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <textarea className="input min-h-24 md:col-span-2" aria-label="Decision" placeholder="What was decided?" value={form.decision} onChange={(e) => setForm({ ...form, decision: e.target.value })} />
      <textarea className="input min-h-20" aria-label="Rationale" placeholder="Why?" value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} />
      <textarea className="input min-h-20" aria-label="Alternatives" placeholder="Alternatives, one per line" value={form.alternatives} onChange={(e) => setForm({ ...form, alternatives: e.target.value })} />
      <textarea className="input min-h-20 md:col-span-2 font-mono text-[11px]" aria-label="Provenance" value={form.provenance} onChange={(e) => setForm({ ...form, provenance: e.target.value })} />
      <button className="btn sm w-fit" disabled={!form.title || !form.decision} onClick={() => save(correction)}>{correction ? "Save correction" : "Save memory"}</button>
    </div>}
    <div className="max-w-6xl mx-auto grid gap-3">{query.data?.decisions.map((row) => <article key={row.id} className={`border rounded-lg p-4 ${row.status === "active" ? "border-[var(--color-hair)]" : "border-[var(--color-hair)] opacity-55"}`}>
      <div className="flex gap-2 items-center"><span className="tag">{row.kind}</span><strong className="text-[14px]">{row.title}</strong><span className="ml-auto text-[11px] text-[var(--color-muted)]">{row.source} · {row.status}</span></div>
      <p className="mt-2 text-[13px] whitespace-pre-wrap">{row.decision}</p>{row.rationale && <p className="mt-2 text-[12px] text-[var(--color-muted)]">Why: {row.rationale}</p>}
      {row.alternativesJson.length > 0 && <p className="mt-1 text-[12px] text-[var(--color-muted)]">Alternatives: {row.alternativesJson.join(" · ")}</p>}
      {!spectator && row.status === "active" && <button className="btn xs ghost mt-3" onClick={() => correct(row)}>Correct with provenance</button>}
    </article>)}</div>
  </div>;
}

function AppsPanel() {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const tasksQ = useTasks();
  const [taskId, setTaskId] = useState("");
  const [artifactId, setArtifactId] = useState("");
  const [name, setName] = useState("");
  const appsQ = useQuery<{ apps: AppRow[] }>({ queryKey: ["platform", "apps"], queryFn: () => api.get("/apps"), refetchInterval: 5_000 });
  const artifactsQ = useQuery<{ artifacts: Array<{ id: string; name: string; contentType: string }> }>({ queryKey: ["task-artifacts", taskId], queryFn: () => api.get(`/tasks/${taskId}/artifacts`), enabled: Boolean(taskId) });
  async function create() { await api.post("/apps", { taskId, artifactId, name }); setName(""); await qc.invalidateQueries({ queryKey: ["platform", "apps"] }); }
  async function act(path: string, body?: unknown) { await api.post(path, body ?? {}); await qc.invalidateQueries({ queryKey: ["platform", "apps"] }); }
  return <div><SectionHead title="App preview and hosting" description="Turn a task’s HTML artifact into a token-isolated preview. Publishing is a separate, auditable human decision; every deployment exposes immutable artifact identity, logs, and a health check." />
    {!spectator && <div className="max-w-6xl mx-auto mb-5 border border-[var(--color-hair)] rounded-lg p-4 grid md:grid-cols-4 gap-2">
      <select className="input" aria-label="App task" value={taskId} onChange={(e) => { setTaskId(e.target.value); setArtifactId(""); }}><option value="">Choose task…</option>{tasksQ.data?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
      <select className="input" aria-label="HTML artifact" value={artifactId} onChange={(e) => setArtifactId(e.target.value)}><option value="">Choose HTML artifact…</option>{artifactsQ.data?.artifacts.filter((artifact) => artifact.contentType.includes("html")).map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.name}</option>)}</select>
      <input className="input" aria-label="App name" placeholder="App name" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn sm" disabled={!taskId || !artifactId || !name} onClick={create}><Plus size={13} /> Create preview</button>
    </div>}
    <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-3">{appsQ.data?.apps.map((row) => <article key={row.id} className="border border-[var(--color-hair)] rounded-lg p-4">
      <div className="flex items-center gap-2"><strong>{row.name}</strong><span className="tag">{row.status}</span><span className="ml-auto text-[11px] text-[var(--color-muted)]">{row.deployments[0]?.healthStatus}</span></div>
      <div className="flex gap-2 mt-3"><a className="btn xs ghost" href={row.previewUrl} target="_blank" rel="noreferrer">Preview <ExternalLink size={11} /></a>{row.status === "published" && <a className="btn xs ghost" href={row.publicUrl} target="_blank" rel="noreferrer">Public app <ExternalLink size={11} /></a>}</div>
      {!spectator && <div className="flex gap-2 mt-3">{row.status === "preview" && <button className="btn xs" onClick={() => act(`/apps/${row.id}/request-publish`)}>Request publish</button>}{row.status === "pending" && <><button className="btn xs" onClick={() => act(`/apps/${row.id}/review`, { decision: "approve" })}>Approve</button><button className="btn xs ghost" onClick={() => act(`/apps/${row.id}/review`, { decision: "reject" })}>Reject</button></>}</div>}
      <div className="mt-3 border-t border-[var(--color-hair)] pt-2 text-[11px] text-[var(--color-muted)]">{row.logs.slice(0, 4).map((log) => <div key={log.id}>{log.event}{log.message ? ` — ${log.message}` : ""}</div>)}</div>
    </article>)}</div>
  </div>;
}

function PrRoomsPanel() {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const conversations = useConversations();
  const connectorsQ = useQuery<{ connectors: Connector[] }>({ queryKey: ["automation", "connectors"], queryFn: () => api.get("/connectors") });
  const roomsQ = useQuery<{ rooms: PrRoom[] }>({ queryKey: ["platform", "pr-rooms"], queryFn: () => api.get("/pr-rooms") });
  const channels = conversations.data?.conversations.filter((row) => row.kind === "channel") ?? [];
  const [form, setForm] = useState({ provider: "github", repository: "", prNumber: "", conversationId: "", connectorId: "" });
  async function create() { await api.post("/pr-rooms", { ...form, prNumber: Number(form.prNumber), connectorId: form.connectorId || null }); await qc.invalidateQueries({ queryKey: ["platform", "pr-rooms"] }); }
  async function sync(id: string) { await api.post(`/pr-rooms/${id}/sync`, {}); await qc.invalidateQueries({ queryKey: ["platform", "pr-rooms"] }); }
  return <div><SectionHead title="Provider-backed Git and PR rooms" description="Attach a GitHub or GitLab pull/merge request to a channel. Sync reads the provider’s PR, changed files, checks, reviews, and branch protection through a governed connector." />
    {!spectator && <div className="max-w-6xl mx-auto mb-5 grid md:grid-cols-5 gap-2 border border-[var(--color-hair)] rounded-lg p-4">
      <select className="input" aria-label="PR provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select>
      <input className="input" aria-label="Repository" placeholder="owner/repository" value={form.repository} onChange={(e) => setForm({ ...form, repository: e.target.value })} />
      <input className="input" aria-label="PR number" type="number" min="1" placeholder="PR #" value={form.prNumber} onChange={(e) => setForm({ ...form, prNumber: e.target.value })} />
      <select className="input" aria-label="PR channel" value={form.conversationId} onChange={(e) => setForm({ ...form, conversationId: e.target.value })}><option value="">Channel…</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select>
      <select className="input" aria-label="Git connector" value={form.connectorId} onChange={(e) => setForm({ ...form, connectorId: e.target.value })}><option value="">Connector later…</option>{connectorsQ.data?.connectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.name}</option>)}</select>
      <button className="btn sm w-fit" disabled={!form.repository || !form.prNumber || !form.conversationId} onClick={create}><Plus size={13} /> Create PR room</button>
    </div>}
    <div className="max-w-6xl mx-auto grid gap-3">{roomsQ.data?.rooms.map((room) => <article key={room.id} className="border border-[var(--color-hair)] rounded-lg p-4">
      <div className="flex gap-2 items-center"><GitPullRequest size={14} /><strong>{room.title || `${room.repository} #${room.prNumber}`}</strong><span className="tag">{room.provider}</span><span className="tag">{room.state}</span>{!spectator && <button className="btn xs ghost ml-auto" onClick={() => sync(room.id)}><RefreshCw size={11} /> Sync</button>}</div>
      <p className="mt-2 text-[12px] text-[var(--color-muted)] font-mono">{room.headRef || "head"} → {room.baseRef || "base"}</p>
      <div className="mt-2 flex gap-4 text-[12px]"><span>{room.diffJson.length} files</span><span>{room.checksJson.length} checks</span><span>{room.reviewsJson.length} reviews</span><span>{Object.keys(room.protectionJson).length ? "protected" : "protection unknown"}</span></div>
      {room.lastError && <p className="mt-2 text-[12px] text-[var(--color-err)]">{room.lastError}</p>}{room.url && <a href={room.url} target="_blank" rel="noreferrer" className="text-[12px] underline">Open provider PR</a>}
    </article>)}</div>
  </div>;
}

function StagesPanel() {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const agentsQ = useQuery<{ agents: Agent[] }>({ queryKey: ["agents"], queryFn: () => api.get("/agents") });
  const stagesQ = useQuery<{ stages: Stage[] }>({ queryKey: ["platform", "stages"], queryFn: () => api.get("/board-stages") });
  const [editing, setEditing] = useState<Stage | null>(null);
  async function save() { if (!editing) return; await api.put(`/board-stages/${editing.stage}`, { title: editing.title, position: editing.position, instructions: editing.instructions, entryRules: editing.entryRulesJson, exitRules: editing.exitRulesJson, agentId: editing.agentId, skill: editing.skill, verification: editing.verification, escalationMemberId: editing.escalationMemberId, nextStage: editing.nextStage }); setEditing(null); await qc.invalidateQueries({ queryKey: ["platform", "stages"] }); }
  return <div><SectionHead title="Executable board stages" description="Each stage can enforce entry/exit evidence, assign an agent and skill, carry instructions, require verification, escalate violations, and define the next transition." />
    <div className="max-w-6xl mx-auto grid gap-3">{stagesQ.data?.stages.map((stage) => <article key={stage.stage} className="border border-[var(--color-hair)] rounded-lg p-4"><div className="flex gap-2 items-center"><strong>{stage.title}</strong><span className="tag font-mono">{stage.stage}</span><span className="ml-auto text-[11px] text-[var(--color-muted)]">next: {stage.nextStage ?? "terminal"}</span>{!spectator && <button className="btn xs ghost" onClick={() => setEditing({ ...stage })}>Configure</button>}</div><p className="mt-2 text-[12px] text-[var(--color-muted)]">{stage.instructions || "No stage instructions."}</p><div className="mt-2 flex gap-3 text-[11px]"><span>verification: {stage.verification}</span><span>agent: {agentsQ.data?.agents.find((agent) => agent.id === stage.agentId)?.name ?? "none"}</span><span>skill: {stage.skill ?? "none"}</span></div></article>)}</div>
    {editing && <div className="fixed inset-0 z-50 grid place-items-center bg-black/35"><div className="bg-[var(--color-bg)] border border-[var(--color-hair)] rounded-lg p-5 w-[min(680px,92vw)] max-h-[85vh] overflow-auto"><h2 className="font-semibold">Configure {editing.stage}</h2><div className="grid md:grid-cols-2 gap-2 mt-4">
      <input className="input" aria-label="Stage title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /><input className="input" aria-label="Stage position" type="number" value={editing.position} onChange={(e) => setEditing({ ...editing, position: Number(e.target.value) })} />
      <textarea className="input min-h-24 md:col-span-2" aria-label="Stage instructions" placeholder="Instructions injected into the assigned agent run" value={editing.instructions} onChange={(e) => setEditing({ ...editing, instructions: e.target.value })} />
      <select className="input" aria-label="Stage agent" value={editing.agentId ?? ""} onChange={(e) => setEditing({ ...editing, agentId: e.target.value || null })}><option value="">No automatic agent</option>{agentsQ.data?.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><input className="input" aria-label="Stage skill" placeholder="Skill name" value={editing.skill ?? ""} onChange={(e) => setEditing({ ...editing, skill: e.target.value || null })} />
      <select className="input" aria-label="Stage verification" value={editing.verification} onChange={(e) => setEditing({ ...editing, verification: e.target.value })}>{["none", "artifact", "judge", "human"].map((value) => <option key={value}>{value}</option>)}</select><select className="input" aria-label="Next stage" value={editing.nextStage ?? ""} onChange={(e) => setEditing({ ...editing, nextStage: e.target.value || null })}><option value="">Terminal</option>{stagesQ.data?.stages.map((value) => <option key={value.stage} value={value.stage}>{value.title}</option>)}</select>
      <RuleChecks label="Entry rules" value={editing.entryRulesJson} onChange={(entryRulesJson) => setEditing({ ...editing, entryRulesJson })} /><RuleChecks label="Exit rules" value={editing.exitRulesJson} onChange={(exitRulesJson) => setEditing({ ...editing, exitRulesJson })} />
    </div><div className="flex gap-2 mt-4"><button className="btn sm" onClick={save}>Save stage</button><button className="btn sm ghost" onClick={() => setEditing(null)}>Cancel</button></div></div></div>}
  </div>;
}

function RuleChecks({ label, value, onChange }: { label: string; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  return <fieldset className="border border-[var(--color-hair)] rounded p-3"><legend className="text-[11px] uppercase text-[var(--color-muted)]">{label}</legend>{[["requireAssignee", "Assignee"], ["requireArtifact", "Artifact"], ["requireVerification", "Passed verification"]].map(([key, text]) => <label key={key} className="flex gap-2 text-[12px] mt-1"><input type="checkbox" checked={value[key] === true} onChange={(e) => onChange({ ...value, [key]: e.target.checked })} /> Require {text}</label>)}</fieldset>;
}

function BlueprintsPanel() {
  const qc = useQueryClient(); const spectator = useSpectator(); const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const query = useQuery<{ blueprints: Blueprint[] }>({ queryKey: ["platform", "blueprints"], queryFn: () => api.get("/team-blueprints") });
  async function create() { await api.post("/team-blueprints", { name, description, exportWorkspace: true }); setName(""); setDescription(""); await qc.invalidateQueries({ queryKey: ["platform", "blueprints"] }); }
  async function apply(id: string) { if (!window.confirm("Instantiate this blueprint in the current workspace?")) return; const result = await api.post<Record<string, number>>(`/team-blueprints/${id}/apply`, {}); window.alert(`Created ${result.agents} agents, ${result.channels} channels, and ${result.workflows} workflows.`); }
  return <div><SectionHead title="Reusable team blueprints" description="Package agents, reporting lines, skills, scopes, budgets, private collaboration channels, and workflows into an immutable version. Applying a version instantiates a fresh team without copying credentials." />
    {!spectator && <div className="max-w-6xl mx-auto mb-5 flex gap-2"><input className="input" aria-label="Blueprint name" placeholder="Blueprint name" value={name} onChange={(e) => setName(e.target.value)} /><input className="input flex-1" aria-label="Blueprint description" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} /><button className="btn sm" disabled={!name} onClick={create}>Export current team</button></div>}
    <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-3">{query.data?.blueprints.map((row) => <article key={row.id} className="border border-[var(--color-hair)] rounded-lg p-4"><div className="flex items-center gap-2"><PackageOpen size={14} /><strong>{row.name}</strong><span className="tag">v{row.version}</span>{!spectator && <button className="btn xs ghost ml-auto" onClick={() => apply(row.id)}>Instantiate</button>}</div><p className="mt-2 text-[12px] text-[var(--color-muted)]">{row.description}</p><div className="flex gap-3 mt-3 text-[11px]"><span>{row.definitionJson.agents.length} agents</span><span>{row.definitionJson.skills.length} skills</span><span>{row.definitionJson.channels.length} channels</span><span>{row.definitionJson.workflows.length} workflows</span></div></article>)}</div>
  </div>;
}

function RunControlPanel() {
  const qc = useQueryClient(); const spectator = useSpectator();
  const query = useQuery<{ runs: Array<{ id: string; type: "agent" | "workflow"; name: string; status: string; trigger?: string; currentStateId?: string | null; waitKind?: string | null; ownerMemberId: string | null; steerJson: unknown[]; followupJson: unknown[]; timeoutAt: string | null; startedAt: string }> }>({ queryKey: ["platform", "active-runs"], queryFn: () => api.get("/active-runs"), refetchInterval: 2_000 });
  async function control(run: { id: string; type: "agent" | "workflow" }, action: string) { let body: Record<string, unknown> = { action }; if (action === "steer" || action === "follow_up") { const text = window.prompt(action === "steer" ? "Steer this active run:" : "Queue a follow-up turn:"); if (!text) return; body.text = text; } if (action === "extend") body.seconds = 3600; await api.post(`/${run.type}-runs/${run.id}/control`, body); await qc.invalidateQueries({ queryKey: ["platform", "active-runs"] }); }
  return <div><SectionHead title="Cancellable and steerable runs" description="Active agent and workflow runs have persisted ownership, cancel, steer, queued follow-up, and timeout-extension controls. Cancellation is checked before any returned action can be applied." /><div className="max-w-6xl mx-auto grid gap-3">{query.data?.runs.length === 0 && <p className="text-[13px] text-[var(--color-muted)]">No active runs.</p>}{query.data?.runs.map((run) => <article key={`${run.type}:${run.id}`} className="border border-[var(--color-hair)] rounded-lg p-4 flex gap-3 items-center"><span className="tag">{run.type}</span><div><strong className="text-[13px]">{run.name}</strong><p className="text-[11px] text-[var(--color-muted)]">{run.status}{run.waitKind ? ` · waiting: ${run.waitKind}` : ""}{run.currentStateId ? ` · ${run.currentStateId}` : ""}</p></div>{!spectator && <div className="ml-auto flex gap-1"><button className="btn xs ghost" onClick={() => control(run, "claim")}>Claim</button><button className="btn xs ghost" onClick={() => control(run, "steer")}>Steer</button><button className="btn xs ghost" onClick={() => control(run, "follow_up")}>Follow up</button><button className="btn xs ghost" onClick={() => control(run, "extend")}>+1h</button><button className="btn xs ghost text-[var(--color-err)]" onClick={() => control(run, "cancel")}><Square size={10} /> Cancel</button></div>}</article>)}</div></div>;
}

function AccessPanel() {
  const qc = useQueryClient(); const spectator = useSpectator();
  const query = useQuery<{ workspace: { retentionDays: number | null; dataResidency: string }; access: { role: string; permissions: string[] }; roles: Array<{ id: string; key: string; name: string; permissionsJson: string[] }>; builtInRoles: Array<{ key: string; name: string; permissions: string[] }>; serviceAccounts: Array<{ id: string; name: string; scopesJson: string[]; revokedAt: string | null }>; sso: null | { issuer: string; clientId: string; domains: string[]; defaultRole: string; enabled: boolean } }>({ queryKey: ["platform", "enterprise"], queryFn: () => api.get("/enterprise") });
  const [role, setRole] = useState({ key: "reviewer", name: "Reviewer", permissions: "workspace.read,runs.control,audit.export" });
  const [serviceName, setServiceName] = useState("CI automation"); const [newToken, setNewToken] = useState("");
  const [governance, setGovernance] = useState({ retentionDays: "", dataResidency: "operator" });
  useEffect(() => { if (query.data?.workspace) setGovernance({ retentionDays: query.data.workspace.retentionDays == null ? "" : String(query.data.workspace.retentionDays), dataResidency: query.data.workspace.dataResidency }); }, [query.data?.workspace]);
  const isAdmin = query.data?.access.permissions.includes("*") === true;
  async function createRole() { await api.post("/enterprise/roles", { key: role.key, name: role.name, permissions: role.permissions.split(",").map((value) => value.trim()).filter(Boolean) }); await qc.invalidateQueries({ queryKey: ["platform", "enterprise"] }); }
  async function createService() { const result = await api.post<{ token: string }>("/enterprise/service-accounts", { name: serviceName, scopes: ["workflows.read", "workflows.run"] }); setNewToken(result.token); await qc.invalidateQueries({ queryKey: ["platform", "enterprise"] }); }
  async function saveGovernance() { await api.put("/enterprise/governance", { retentionDays: governance.retentionDays ? Number(governance.retentionDays) : null, dataResidency: governance.dataResidency }); await qc.invalidateQueries({ queryKey: ["platform", "enterprise"] }); }
  return <div><SectionHead title="Enterprise access and governance" description="Guests and channel boundaries, custom RBAC, OIDC SSO, scoped service identities, exportable audit events, retention, and an explicit data-residency policy—without exposing stored credentials." />
    <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-4">
      <section className="border border-[var(--color-hair)] rounded-lg p-4"><h2 className="font-semibold text-[14px] flex gap-2"><Users size={14} /> Roles</h2><p className="text-[11px] text-[var(--color-muted)] mt-1">You are {query.data?.access.role}.</p>{[...(query.data?.builtInRoles ?? []), ...(query.data?.roles ?? []).map((value) => ({ ...value, permissions: value.permissionsJson }))].map((value) => <div key={value.key} className="mt-2 text-[12px]"><strong>{value.name}</strong> <span className="font-mono text-[10px] text-[var(--color-muted)]">{value.key}</span><div className="text-[11px] text-[var(--color-muted)]">{value.permissions.join(", ")}</div></div>)}{isAdmin && !spectator && <div className="mt-3 grid gap-2"><input className="input" aria-label="Role key" value={role.key} onChange={(e) => setRole({ ...role, key: e.target.value })} /><input className="input" aria-label="Role name" value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} /><input className="input" aria-label="Role permissions" value={role.permissions} onChange={(e) => setRole({ ...role, permissions: e.target.value })} /><button className="btn xs w-fit" onClick={createRole}>Save custom role</button></div>}</section>
      <section className="border border-[var(--color-hair)] rounded-lg p-4"><h2 className="font-semibold text-[14px]">Governance</h2><label className="block text-[11px] mt-3">Retention days<input className="input w-full mt-1" aria-label="Retention days" type="number" value={governance.retentionDays} onChange={(e) => setGovernance({ ...governance, retentionDays: e.target.value })} /></label><label className="block text-[11px] mt-2">Data residency label<input className="input w-full mt-1" aria-label="Data residency" value={governance.dataResidency} onChange={(e) => setGovernance({ ...governance, dataResidency: e.target.value })} /></label>{isAdmin && <button className="btn xs mt-3" onClick={saveGovernance}>Save governance</button>}<a className="btn xs ghost mt-3 ml-2" href="/api/enterprise/audit?format=csv&days=30">Export audit CSV</a></section>
      <section className="border border-[var(--color-hair)] rounded-lg p-4"><h2 className="font-semibold text-[14px]">Service accounts</h2>{query.data?.serviceAccounts.map((account) => <div key={account.id} className="mt-2 text-[12px]"><strong>{account.name}</strong> <span className="text-[var(--color-muted)]">{account.revokedAt ? "revoked" : account.scopesJson.join(", ")}</span></div>)}{isAdmin && !spectator && <div className="mt-3 flex gap-2"><input className="input" aria-label="Service account name" value={serviceName} onChange={(e) => setServiceName(e.target.value)} /><button className="btn xs" onClick={createService}>Create</button></div>}{newToken && <div className="mt-3 p-2 border border-[var(--color-warn)] rounded text-[11px]"><strong>Copy once:</strong><code className="block break-all mt-1">{newToken}</code><button className="btn xs ghost mt-1" onClick={() => navigator.clipboard.writeText(newToken)}>Copy</button></div>}</section>
      <section className="border border-[var(--color-hair)] rounded-lg p-4"><h2 className="font-semibold text-[14px]">OIDC SSO</h2>{query.data?.sso ? <><p className="text-[12px] mt-2">{query.data.sso.issuer}</p><p className="text-[11px] text-[var(--color-muted)]">Domains: {query.data.sso.domains.join(", ") || "any"} · default {query.data.sso.defaultRole} · {query.data.sso.enabled ? "enabled" : "disabled"}</p></> : <p className="text-[12px] mt-2 text-[var(--color-muted)]">Not configured. Use PUT /api/enterprise/sso after registering the callback URL shown in the platform docs.</p>}</section>
    </div>
  </div>;
}
