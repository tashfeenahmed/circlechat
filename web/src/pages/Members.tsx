import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  UserPlus,
  Bot,
  X,
  Copy,
  Check,
  MessageSquare,
  Mail,
  ExternalLink,
} from "lucide-react";
import { useMembersDirectory, useConversations, useMe } from "../lib/hooks";
import { api } from "../api/client";
import Avatar from "../components/Avatar";
import { useQueryClient } from "@tanstack/react-query";
import { useBus } from "../state/store";

type Tab = "humans" | "agents";

export default function MembersPage() {
  const dir = useMembersDirectory();
  const convs = useConversations();
  const me = useMe();
  const [tab, setTab] = useState<Tab>("humans");
  const [q, setQ] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const presence = useBus((s) => s.presence);

  const channels = (convs.data?.conversations ?? []).filter((c) => c.kind === "channel");

  const humans = useMemo(
    () =>
      (dir.data?.humans ?? []).filter((h) => {
        if (!q) return true;
        const hh = h as { name: string; handle: string; email: string };
        const qq = q.toLowerCase();
        return hh.name.toLowerCase().includes(qq) || hh.handle.toLowerCase().includes(qq) || hh.email.toLowerCase().includes(qq);
      }),
    [dir.data?.humans, q],
  );

  const agentsList = useMemo(
    () =>
      (dir.data?.agents ?? []).filter((a) => {
        if (!q) return true;
        const aa = a as { name: string; handle: string };
        const qq = q.toLowerCase();
        return aa.name.toLowerCase().includes(qq) || aa.handle.toLowerCase().includes(qq);
      }),
    [dir.data?.agents, q],
  );

  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title">Members</div>
        <div className="ch-meta">
          <span>{(dir.data?.humans ?? []).length} people · {(dir.data?.agents ?? []).length} agents</span>
        </div>
        <div className="ch-right">
          <button onClick={() => setInviteOpen(true)} className="btn sm inline-flex items-center gap-1">
            <UserPlus size={13} strokeWidth={2} /> Invite teammate
          </button>
          <button onClick={() => setAgentOpen(true)} className="btn primary sm inline-flex items-center gap-1">
            <Bot size={13} strokeWidth={2} /> Add agent
          </button>
        </div>
      </header>

      <div className="px-6 pt-3 pb-2 flex items-center gap-3 border-b border-[var(--color-hair)]">
        <div className="flex items-center gap-1 border border-[var(--color-hair-2)] rounded overflow-hidden">
          <button
            onClick={() => setTab("humans")}
            className={`px-3 py-1 text-[13px] inline-flex items-center gap-2 ${tab === "humans" ? "bg-[var(--color-ink)] text-white" : "text-[var(--color-muted)] hover:bg-[var(--color-hi)]"}`}
          >
            People
            <span className={`text-[10px] font-mono px-1.5 py-[1px] rounded ${tab === "humans" ? "bg-white/20" : "bg-[var(--color-hi)]"}`}>
              {(dir.data?.humans ?? []).length}
            </span>
          </button>
          <button
            onClick={() => setTab("agents")}
            className={`px-3 py-1 text-[13px] inline-flex items-center gap-2 ${tab === "agents" ? "bg-[var(--color-ink)] text-white" : "text-[var(--color-muted)] hover:bg-[var(--color-hi)]"}`}
          >
            Agents
            <span className={`text-[10px] font-mono px-1.5 py-[1px] rounded ${tab === "agents" ? "bg-white/20" : "bg-[var(--color-hi)]"}`}>
              {(dir.data?.agents ?? []).length}
            </span>
          </button>
        </div>
        <div className="flex items-center gap-2 flex-1 max-w-[380px] bg-[var(--color-bg-2)] rounded px-3 py-1.5">
          <Search size={13} strokeWidth={2} className="text-[var(--color-muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === "humans" ? "Search people…" : "Search agents…"}
            className="flex-1 bg-transparent outline-none text-[13px]"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {tab === "humans" && (
          <ul className="divide-y divide-[var(--color-hair)]">
            {humans.length === 0 && (
              <li className="px-6 py-10 text-center text-[13px] text-[var(--color-muted)]">
                No people match.
              </li>
            )}
            {humans.map((h) => {
              const hh = h as {
                memberId: string;
                id: string;
                name: string;
                handle: string;
                avatarColor: string;
                email: string;
              };
              const isMe = hh.memberId === me.data?.memberId;
              const status = presence[hh.memberId] ?? "offline";
              return (
                <li key={hh.memberId} className="group px-6 py-2.5 flex items-center gap-3 hover:bg-[var(--color-hi)]">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      useBus.getState().openDetails(hh.memberId);
                    }}
                    title="Open profile"
                  >
                    <Avatar name={hh.name} color={hh.avatarColor} size="md" status={status} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold">{hh.name}</span>
                      {isMe && <span className="text-[10px] font-mono uppercase tracking-wide text-[var(--color-muted)]">you</span>}
                      <span className="text-[12px] font-mono text-[var(--color-muted)]">@{hh.handle}</span>
                    </div>
                    <div className="text-[12px] text-[var(--color-muted)] inline-flex items-center gap-1.5 mt-0.5">
                      <Mail size={11} strokeWidth={2} /> {hh.email}
                    </div>
                  </div>
                  {!isMe && (
                    <button
                      onClick={() => nav(`/d/${hh.memberId}`)}
                      className="btn sm ghost inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Open DM"
                    >
                      <MessageSquare size={13} strokeWidth={2} /> Message
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {tab === "agents" && (
          <ul className="divide-y divide-[var(--color-hair)]">
            {agentsList.length === 0 && (
              <li className="px-6 py-10 text-center text-[13px] text-[var(--color-muted)]">
                No agents yet. Provision one to get started.
              </li>
            )}
            {agentsList.map((a) => {
              const aa = a as {
                memberId: string;
                id: string;
                name: string;
                handle: string;
                avatarColor: string;
                agentKind: string;
                status: string;
                brief: string;
              };
              return (
                <li
                  key={aa.memberId}
                  className="group px-6 py-2.5 flex items-start gap-3 hover:bg-[var(--color-hi)] cursor-pointer"
                  onClick={() => nav(`/agents/${aa.id}`)}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      useBus.getState().openDetails(aa.memberId);
                    }}
                    title="Open profile"
                  >
                    <Avatar name={aa.name} color={aa.avatarColor} agent size="md" status={aa.status === "working" ? "working" : aa.status === "idle" ? "idle" : "offline"} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold">{aa.name}</span>
                      <span className="tag agent">agent</span>
                      <span className="text-[12px] font-mono text-[var(--color-muted)]">@{aa.handle}</span>
                      {(aa as { title?: string }).title && (
                        <span className="text-[12px] text-[var(--color-ink)]">· {(aa as { title?: string }).title}</span>
                      )}
                      <span className="text-[11px] font-mono text-[var(--color-muted-2)]">
                        · {aa.agentKind} · {aa.status}
                      </span>
                    </div>
                    {aa.brief && (
                      <div className="text-[12.5px] text-[var(--color-muted)] mt-0.5 line-clamp-2 max-w-[640px]">
                        {aa.brief}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        nav(`/d/${aa.memberId}`);
                      }}
                      className="btn sm ghost inline-flex items-center gap-1"
                      title="Open DM"
                    >
                      <MessageSquare size={13} strokeWidth={2} /> DM
                    </button>
                    <button
                      onClick={() => nav(`/agents/${aa.id}`)}
                      className="btn sm ghost inline-flex items-center gap-1"
                      title="Open agent page"
                    >
                      <ExternalLink size={13} strokeWidth={2} /> Open
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}
      {agentOpen && (
        <AddAgent
          channels={channels}
          onClose={() => setAgentOpen(false)}
          onCreated={async (id) => {
            await qc.invalidateQueries({ queryKey: ["members"] });
            await qc.invalidateQueries({ queryKey: ["agents"] });
            await qc.invalidateQueries({ queryKey: ["conversations"] });
            setAgentOpen(false);
            nav(`/agents/${id}`);
          }}
        />
      )}
    </main>
  );
}

function Overlay({
  title,
  subtitle,
  onClose,
  children,
  width = 520,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-md border border-[var(--color-hair-2)] shadow-lg"
        style={{ width, maxWidth: "92vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--color-hair)]">
          <div>
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {subtitle && <p className="text-[12.5px] text-[var(--color-muted)] mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="tb-btn" title="Close"><X size={14} strokeWidth={2} /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Copyable({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore
    }
  }
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] mb-1 font-mono">{label}</div>
      <div className="font-mono text-[12px] bg-[var(--color-bg-2)] border border-[var(--color-hair)] p-2 rounded break-all flex items-start gap-2">
        <span className="flex-1 select-all">{text}</span>
        <button onClick={copy} className="tb-btn shrink-0" title="Copy">
          {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function send() {
    setErr(null);
    try {
      const r = await api.post<{ inviteUrl: string }>("/auth/invite", { email });
      setResult(r.inviteUrl);
      setEmail("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <Overlay title="Invite teammate" subtitle="We'll generate a one-time join link. SMTP is optional in dev." onClose={onClose}>
      <label className="block mb-3">
        <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2"
          autoFocus
        />
      </label>
      {err && <p className="text-[12px] text-[var(--color-err)] mb-2">{err}</p>}
      {result && (
        <div className="mb-3">
          <Copyable label="Invite URL" text={result} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btn sm ghost">Close</button>
        <button onClick={send} className="btn sm primary" disabled={!email}>Send invite</button>
      </div>
    </Overlay>
  );
}

const RUNTIMES: Array<{
  id: "openclaw" | "hermes" | "custom";
  name: string;
  adapter: "webhook" | "socket";
  blurb: string;
  helpUrl?: string;
}> = [
  {
    id: "hermes",
    name: "Hermes",
    adapter: "socket",
    blurb: "Nous Research's agent. Socket mode opens an outbound WS, so it works behind firewalls.",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    adapter: "webhook",
    blurb: "Self-hosted gateway. You give it a webhook URL; we'll POST heartbeats there.",
  },
  {
    id: "custom",
    name: "Custom",
    adapter: "socket",
    blurb: "Anything that speaks HTTP or WebSocket. Pick the adapter on the next step.",
  },
];

function AddAgent({
  channels,
  onClose,
  onCreated,
}: {
  channels: Array<{ id: string; name: string | null }>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  type Mode = "install" | "attach" | null;
  const [mode, setMode] = useState<Mode>(null);

  if (mode === null) {
    return <AddAgentModePicker onPick={setMode} onClose={onClose} />;
  }
  if (mode === "install") {
    return (
      <InstallAgent
        channels={channels}
        onClose={onClose}
        onCreated={onCreated}
        onBack={() => setMode(null)}
      />
    );
  }
  return (
    <AttachAgent
      channels={channels}
      onClose={onClose}
      onCreated={onCreated}
      onBack={() => setMode(null)}
    />
  );
}

function AddAgentModePicker({
  onPick,
  onClose,
}: {
  onPick: (m: "install" | "attach") => void;
  onClose: () => void;
}) {
  return (
    <Overlay
      title="Add an agent"
      subtitle="Install a brand-new agent on this server, or attach one that's already running somewhere."
      onClose={onClose}
      width={560}
    >
      <div className="space-y-2">
        <button
          onClick={() => onPick("install")}
          className="w-full text-left border border-[var(--color-hair-2)] rounded-md p-3 hover:border-[var(--color-ink)] hover:bg-[var(--color-hi)] transition"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold">Install a new agent</span>
            <span className="text-[10px] font-mono uppercase tracking-wide text-[var(--color-muted)]">
              this server hosts it
            </span>
          </div>
          <div className="text-[12.5px] text-[var(--color-muted)] mt-0.5">
            We'll create a fresh Hermes instance on this Pi, wire in your API key, and start it up.
            You won't run anything on your own infra.
          </div>
        </button>
        <button
          onClick={() => onPick("attach")}
          className="w-full text-left border border-[var(--color-hair-2)] rounded-md p-3 hover:border-[var(--color-ink)] hover:bg-[var(--color-hi)] transition"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold">Attach an existing agent</span>
            <span className="text-[10px] font-mono uppercase tracking-wide text-[var(--color-muted)]">
              you host it
            </span>
          </div>
          <div className="text-[12.5px] text-[var(--color-muted)] mt-0.5">
            You already have an agent running (Hermes, OpenClaw, or custom). We give you a bot token and
            a one-line connection command for its gateway.
          </div>
        </button>
      </div>
    </Overlay>
  );
}

// ─────────────── Install: create and run a new agent on this host ───────────────

const PROVIDERS: Array<{
  id: "anthropic" | "openai-codex" | "openrouter" | "nous" | "custom:freeapi";
  label: string;
  hint: string;
  defaultModel: string;
}> = [
  { id: "anthropic", label: "Anthropic (Claude)", hint: "API key from console.anthropic.com", defaultModel: "claude-sonnet-4-5" },
  { id: "openrouter", label: "OpenRouter", hint: "Routes to hundreds of models.", defaultModel: "anthropic/claude-sonnet-4.5" },
  { id: "openai-codex", label: "OpenAI", hint: "API key from platform.openai.com", defaultModel: "gpt-4o" },
  { id: "nous", label: "Nous (hosted Hermes)", hint: "Portal token from nousresearch.com", defaultModel: "" },
  { id: "custom:freeapi", label: "Custom (freeapi)", hint: "Self-hosted gateway.", defaultModel: "gemini-2.5-pro" },
];

function InstallAgent({
  channels,
  onClose,
  onCreated,
  onBack,
}: {
  channels: Array<{ id: string; name: string | null }>;
  onClose: () => void;
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState("Research");
  const [handle, setHandle] = useState("research");
  const [title, setTitle] = useState("Lead Research Specialist");
  const [brief, setBrief] = useState(
    "Reads the channels I belong to. Replies to @mentions and DMs; on scheduled beats, surfaces relevant updates.",
  );
  const [providerId, setProviderId] = useState<(typeof PROVIDERS)[number]["id"]>("anthropic");
  const provider = PROVIDERS.find((p) => p.id === providerId)!;
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(provider.defaultModel);
  const [interval, setInterval] = useState(180);
  const [selectedChannels, setSelected] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState<{ id: string; handle: string } | null>(null);

  function changeProvider(id: (typeof PROVIDERS)[number]["id"]): void {
    setProviderId(id);
    const p = PROVIDERS.find((x) => x.id === id)!;
    if (!model || PROVIDERS.some((x) => x.defaultModel === model)) setModel(p.defaultModel);
  }

  async function install(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ id: string; handle: string }>("/agents/install-hermes", {
        name,
        handle,
        title: title || undefined,
        brief,
        provider: providerId,
        apiKey,
        apiKeyLabel: `${name} (${providerId})`,
        model: model || undefined,
        heartbeatIntervalSec: interval,
        channelIds: selectedChannels,
      });
      setInstalled({ id: r.id, handle: r.handle });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (installed) {
    return (
      <Overlay
        title={`@${installed.handle} is installed`}
        subtitle="The bridge is connecting now. Refresh the agents tab in a few seconds to see it flip from provisioning → idle."
        onClose={onClose}
        width={520}
      >
        <div className="text-[13px] text-[var(--color-muted)] mb-4">
          Your API key was scoped to this agent's <code className="font-mono">HERMES_HOME</code>. It's not
          stored in our DB — only the per-instance Hermes config.
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn sm ghost">Close</button>
          <button onClick={() => onCreated(installed.id)} className="btn sm primary">
            Open agent page
          </button>
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay
      title="Install a new Hermes agent"
      subtitle="We'll run this agent on this server. Everything stays local to your Pi."
      onClose={onClose}
      width={620}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
            />
          </Field>
          <Field label="Handle">
            <div className="flex items-center border border-[var(--color-hair-2)] rounded overflow-hidden">
              <span className="px-2 text-[var(--color-muted)] font-mono text-[13px]">@</span>
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
                className="flex-1 py-2 pr-2 font-mono text-[13px] outline-none"
              />
            </div>
          </Field>
        </div>

        <Field label="Title / role">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Lead Research Specialist"
            className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
          />
        </Field>

        <Field label="Brief · what should this agent do?">
          <textarea
            rows={3}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] leading-relaxed"
          />
        </Field>

        <Field label="Inference provider">
          <select
            value={providerId}
            onChange={(e) => changeProvider(e.target.value as typeof providerId)}
            className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px] bg-white"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <div className="text-[11.5px] text-[var(--color-muted)] mt-1">{provider.hint}</div>
        </Field>

        <Field label="API key">
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={providerId === "anthropic" ? "sk-ant-…" : providerId === "openai-codex" ? "sk-…" : "paste your key"}
            className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] font-mono"
          />
          <div className="text-[11.5px] text-[var(--color-muted)] mt-1">
            Stored only on the server, inside this agent's <code className="font-mono">HERMES_HOME</code>.
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Model">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider.defaultModel || "default"}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px] font-mono"
            />
          </Field>
          <Field label="Heartbeat (sec)">
            <input
              type="number"
              min={15}
              max={3600}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
            />
          </Field>
        </div>

        <Field label="Channels to join">
          {channels.length === 0 ? (
            <div className="text-[12px] text-[var(--color-muted-2)]">No channels yet.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {channels.map((c) => {
                const on = selectedChannels.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() =>
                      setSelected((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))
                    }
                    className={`text-[12px] px-2.5 py-1 rounded border transition ${
                      on
                        ? "bg-[var(--color-ink)] text-white border-[var(--color-ink)]"
                        : "border-[var(--color-hair-2)] text-[var(--color-ink)] hover:bg-[var(--color-hi)]"
                    }`}
                  >
                    #{c.name}
                  </button>
                );
              })}
            </div>
          )}
        </Field>
      </div>

      {err && <p className="text-[12px] text-[var(--color-err)] mt-3">{err}</p>}
      <div className="flex justify-between items-center gap-2 mt-4">
        <button onClick={onBack} className="btn sm ghost">← Back</button>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn sm ghost">Cancel</button>
          <button
            onClick={install}
            disabled={busy || !name || !handle || !apiKey}
            className="btn sm primary"
          >
            {busy ? "Installing…" : "Install & run"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ─────────────── Attach: existing agent connects with its own runtime ───────────────

function AttachAgent({
  channels,
  onClose,
  onCreated,
  onBack,
}: {
  channels: Array<{ id: string; name: string | null }>;
  onClose: () => void;
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const [step, setStep] = useState<"runtime" | "details">("runtime");
  const [kind, setKind] = useState<"openclaw" | "hermes" | "custom">("hermes");
  const [adapter, setAdapter] = useState<"webhook" | "socket">("socket");
  const [name, setName] = useState("Research");
  const [handle, setHandle] = useState("research");
  const [brief, setBrief] = useState(
    "Reads the channels I belong to. Replies to @mentions and DMs; on scheduled beats, surfaces relevant updates.",
  );
  const [model, setModel] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [interval, setInterval] = useState(60);
  const [selectedChannels, setSelected] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<{ botToken: string; handle: string; id: string } | null>(null);

  function pickRuntime(r: (typeof RUNTIMES)[number]) {
    setKind(r.id);
    setAdapter(r.adapter);
    setStep("details");
  }

  async function create() {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ id: string; botToken: string; handle: string }>("/agents", {
        name,
        handle,
        kind,
        adapter,
        model: model || undefined,
        brief,
        heartbeatIntervalSec: interval,
        callbackUrl: adapter === "webhook" ? callbackUrl || undefined : undefined,
        channelIds: selectedChannels,
      });
      setCreds({ botToken: r.botToken, handle: r.handle, id: r.id });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (creds) {
    const wssBase = `${location.origin.replace(/^http/, "ws")}/agent-socket`;
    const socketCmd = `CC_BOT_TOKEN=${creds.botToken} CC_WSS_URL=${wssBase} node your-bridge.mjs`;
    const hermesCmd = `# On the host where Hermes runs:\nhermes gateway setup --platform circlechat --token ${creds.botToken} --wss-url ${wssBase}`;
    const webhookCmd = `curl -X POST ${location.origin}/api/agents/${creds.id}/register \\\n  -H 'Authorization: Bearer ${creds.botToken}' \\\n  -d '{"callbackUrl":"https://your-agent.example.com"}'`;
    const attachInstallCmd = `curl -fsSL '${location.origin}/api/public/attach-install/${creds.id}?token=${creds.botToken}' | bash`;
    return (
      <Overlay
        title={`@${creds.handle} provisioned`}
        subtitle="Connect your runtime below. The agent flips from provisioning → idle once reachable."
        onClose={onClose}
        width={640}
      >
        <div className="space-y-4">
          <Copyable label="Bot token (keep secret)" text={creds.botToken} />
          {kind === "hermes" && (
            <div>
              <Copyable label="Install skill + MCP on the Hermes host (one-liner)" text={attachInstallCmd} />
              <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
                Runs on the machine where Hermes lives. Drops the CircleChat skill
                into <code className="font-mono">$HERMES_HOME/skills/circlechat/</code>, writes the MCP
                bridge script, and registers it with <code className="font-mono">hermes mcp add</code>.
              </p>
            </div>
          )}
          <Copyable
            label={adapter === "socket" ? "Start the agent runtime" : "Register the webhook"}
            text={adapter === "socket" ? (kind === "hermes" ? hermesCmd : socketCmd) : webhookCmd}
          />
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn sm ghost">Later</button>
            <button onClick={() => onCreated(creds.id)} className="btn sm primary inline-flex items-center gap-1">
              Open agent page <ExternalLink size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
      </Overlay>
    );
  }

  if (step === "runtime") {
    return (
      <Overlay
        title="Attach an existing agent"
        subtitle="Pick the runtime your agent is using. We'll give you a token and a one-line connection command."
        onClose={onClose}
        width={560}
      >
        <div className="space-y-2">
          {RUNTIMES.map((r) => (
            <button
              key={r.id}
              onClick={() => pickRuntime(r)}
              className="w-full text-left border border-[var(--color-hair-2)] rounded-md p-3 hover:border-[var(--color-ink)] hover:bg-[var(--color-hi)] transition"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[14px] font-semibold">{r.name}</span>
                <span className="text-[10px] font-mono uppercase tracking-wide text-[var(--color-muted)]">
                  {r.adapter}
                </span>
              </div>
              <div className="text-[12.5px] text-[var(--color-muted)] mt-0.5">{r.blurb}</div>
            </button>
          ))}
        </div>
        <div className="flex justify-between items-center gap-2 mt-4">
          <button onClick={onBack} className="btn sm ghost">← Back</button>
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay
      title={`Configure ${kind === "custom" ? "custom" : kind === "hermes" ? "Hermes" : "OpenClaw"} agent`}
      subtitle="You can edit all of this later from the agent's page."
      onClose={onClose}
      width={560}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
            />
          </Field>
          <Field label="Handle">
            <div className="flex items-center border border-[var(--color-hair-2)] rounded overflow-hidden">
              <span className="px-2 text-[var(--color-muted)] font-mono text-[13px]">@</span>
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
                className="flex-1 py-2 pr-2 font-mono text-[13px] outline-none"
              />
            </div>
          </Field>
        </div>

        <Field label="Brief · what should this agent do?">
          <textarea
            rows={3}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] leading-relaxed"
          />
        </Field>

        {kind === "custom" && (
          <Field label="Adapter">
            <div className="flex gap-2">
              {(["socket", "webhook"] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => setAdapter(a)}
                  className={`btn sm ${adapter === a ? "primary" : ""}`}
                >
                  {a === "socket" ? "Socket mode (pull)" : "Webhook (push)"}
                </button>
              ))}
            </div>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Model (optional)">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. gemini-2.5-pro"
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
            />
          </Field>
          <Field label="Heartbeat (seconds)">
            <input
              type="number"
              min={5}
              max={3600}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
            />
          </Field>
        </div>

        {adapter === "webhook" && (
          <Field label="Webhook URL">
            <input
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="https://agent.example.com"
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
            />
          </Field>
        )}

        <Field label="Channels to join">
          {channels.length === 0 ? (
            <div className="text-[12px] text-[var(--color-muted-2)]">No channels yet.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {channels.map((c) => {
                const on = selectedChannels.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() =>
                      setSelected((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))
                    }
                    className={`text-[12px] px-2.5 py-1 rounded border transition ${
                      on
                        ? "bg-[var(--color-ink)] text-white border-[var(--color-ink)]"
                        : "border-[var(--color-hair-2)] text-[var(--color-ink)] hover:bg-[var(--color-hi)]"
                    }`}
                  >
                    #{c.name}
                  </button>
                );
              })}
            </div>
          )}
        </Field>
      </div>

      {err && <p className="text-[12px] text-[var(--color-err)] mt-3">{err}</p>}
      <div className="flex justify-between items-center gap-2 mt-4">
        <button onClick={() => setStep("runtime")} className="btn sm ghost">← Runtime</button>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn sm ghost">Cancel</button>
          <button
            onClick={create}
            disabled={busy || !name || !handle}
            className="btn sm primary"
          >
            {busy ? "Creating…" : "Provision"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
