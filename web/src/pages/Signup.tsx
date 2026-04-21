import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Check as CheckIcon } from "lucide-react";
import { api, type Conversation } from "../api/client";
import { humanizeError } from "../api/errors";
import { useQueryClient } from "@tanstack/react-query";

const PROVIDERS: Array<{
  id: "anthropic" | "openai-codex" | "openrouter" | "nous" | "custom:freeapi";
  label: string;
  hint: string;
  defaultModel: string;
  placeholder: string;
}> = [
  { id: "anthropic", label: "Anthropic (Claude)", hint: "Key from console.anthropic.com", defaultModel: "claude-sonnet-4-5", placeholder: "sk-ant-…" },
  { id: "openrouter", label: "OpenRouter", hint: "Routes to hundreds of models.", defaultModel: "anthropic/claude-sonnet-4.5", placeholder: "sk-or-…" },
  { id: "openai-codex", label: "OpenAI", hint: "Key from platform.openai.com", defaultModel: "gpt-4o", placeholder: "sk-…" },
  { id: "nous", label: "Nous (hosted Hermes)", hint: "Portal token from nousresearch.com", defaultModel: "", placeholder: "paste your token" },
  { id: "custom:freeapi", label: "FreeLLMAPI (self-hosted)", hint: "OpenAI-compatible proxy. Set up from github.com/tashfeenahmed/freellmapi, then paste its base URL + unified key.", defaultModel: "gemini-2.5-pro", placeholder: "freellmapi-…" },
];

const DEFAULT_BRIEF =
  "Reads the channels I belong to. Replies to @mentions and DMs; on scheduled beats, surfaces relevant updates.";

export default function SignupPage() {
  const [step, setStep] = useState(0);
  const [workspaceName, setWorkspace] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Step 2 (agent) state
  const [agentName, setAgentName] = useState("CEO");
  const [agentHandle, setAgentHandle] = useState("ceo");
  const [agentTitle, setAgentTitle] = useState("Chief Executive Officer");
  const [runtime, setRuntime] = useState<"hermes" | "openclaw">("hermes");
  const [providerId, setProviderId] = useState<(typeof PROVIDERS)[number]["id"]>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [model, setModel] = useState(PROVIDERS[0].defaultModel);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();

  const provider = PROVIDERS.find((p) => p.id === providerId)!;

  function changeProvider(id: (typeof PROVIDERS)[number]["id"]): void {
    setProviderId(id);
    const p = PROVIDERS.find((x) => x.id === id)!;
    if (!model || PROVIDERS.some((x) => x.defaultModel === model)) setModel(p.defaultModel);
  }

  async function createAccount(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/auth/signup", { email, password, name, handle, workspaceName });
      // Defer invalidating `me` until the onboarding finishes — otherwise the
      // App-level redirect kicks the user off /signup before step 2 renders.
      setStep(2);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function installAgent(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      const channels = await api.get<{ conversations: Conversation[] }>("/conversations");
      const channelIds = channels.conversations.filter((c) => c.kind === "channel").map((c) => c.id);
      const endpoint = runtime === "openclaw" ? "/agents/install-openclaw" : "/agents/install-hermes";
      const payload: Record<string, unknown> = {
        name: agentName,
        handle: agentHandle,
        title: agentTitle || undefined,
        brief: DEFAULT_BRIEF,
        provider: providerId,
        apiKey,
        apiBaseUrl: providerId === "custom:freeapi" ? apiBaseUrl : undefined,
        model: model || undefined,
        heartbeatIntervalSec: 180,
        channelIds,
      };
      if (runtime === "hermes") payload.apiKeyLabel = `${agentName} (${providerId})`;
      await api.post(endpoint, payload);
      await qc.invalidateQueries();
      nav("/members", { replace: true });
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function skip(): Promise<void> {
    await qc.invalidateQueries();
    nav("/members", { replace: true });
  }

  return (
    <div className="min-h-screen grid place-items-center px-6 py-12 bg-[var(--color-bg-2)]">
      <div className="w-full max-w-[480px] bg-white border border-[var(--color-hair-2)] rounded p-8 shadow-sm">
        <div className="brand text-[22px] leading-none mb-1">Circle</div>
        <div className="text-[11px] uppercase tracking-widest text-[var(--color-muted)] mb-5 font-mono">
          Step {step + 1} of 3
        </div>

        {step === 0 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (workspaceName) setStep(1);
            }}
          >
            <h1 className="text-[18px] font-semibold mb-1">Name your workspace</h1>
            <p className="text-[13px] text-[var(--color-muted)] mb-5">You can create more later from the rail.</p>
            <input
              autoFocus
              placeholder="Acme Team"
              value={workspaceName}
              onChange={(e) => setWorkspace(e.target.value)}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 mb-3"
            />
            <button
              type="submit"
              className="w-full bg-[var(--color-ink)] text-white rounded py-2 text-[13px] font-medium"
            >
              Continue
            </button>
          </form>
        )}

        {step === 1 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name && handle && email && password.length >= 8 && !busy) void createAccount();
            }}
          >
            <h1 className="text-[18px] font-semibold mb-1">Create your account</h1>
            <p className="text-[13px] text-[var(--color-muted)] mb-5">You'll be workspace admin.</p>
            <div className="space-y-3">
              <input
                autoFocus
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2"
              />
              <input
                placeholder="handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase())}
                className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 font-mono"
              />
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2"
              />
              <input
                type="password"
                placeholder="Password (8+ chars)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2"
              />
            </div>
            {err && <p className="text-[12px] text-[var(--color-err)] mt-3">{err}</p>}
            <div className="flex justify-between mt-4">
              <button type="button" onClick={() => { setErr(null); setStep(0); }} className="text-[13px] text-[var(--color-muted)]">
                Back
              </button>
              <button
                type="submit"
                disabled={busy || !name || !handle || !email || password.length < 8}
                className="bg-[var(--color-ink)] text-white rounded py-2 px-4 text-[13px] font-medium disabled:opacity-60"
              >
                {busy ? "Creating…" : "Continue"}
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!agentName || agentHandle.length < 2 || apiKey.length < 10 || busy) return;
              if (providerId === "custom:freeapi" && apiBaseUrl.trim().length < 10) return;
              void installAgent();
            }}
          >
            <h1 className="text-[18px] font-semibold mb-1">Add your first agent</h1>
            <p className="text-[13px] text-[var(--color-muted)] mb-4">
              We'll run it on this server, wire in your API key, and install the CircleChat MCP + skill for
              you. You can skip this and add one later from{" "}
              <span className="font-mono">Members → Add agent</span>.
            </p>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Name</div>
                  <input
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
                  />
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Handle</div>
                  <div className="flex items-center border border-[var(--color-hair-2)] rounded overflow-hidden">
                    <span className="px-2 text-[var(--color-muted)] font-mono text-[13px]">@</span>
                    <input
                      value={agentHandle}
                      onChange={(e) => setAgentHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
                      className="flex-1 py-2 pr-2 font-mono text-[13px] outline-none"
                    />
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Title / role</div>
                <input
                  value={agentTitle}
                  onChange={(e) => setAgentTitle(e.target.value)}
                  placeholder="Chief Executive Officer"
                  className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
                />
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Runtime</div>
                <div className="flex gap-2">
                  {[
                    { id: "hermes" as const, label: "Hermes", hint: "Nous Research agent" },
                    { id: "openclaw" as const, label: "OpenClaw", hint: "Lobster-powered alt" },
                  ].map((r) => {
                    const selected = runtime === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setRuntime(r.id)}
                        className={`runtime-opt ${selected ? "selected" : ""}`}
                      >
                        <span className={`runtime-dot ${selected ? "selected" : ""}`}>
                          {selected && <CheckIcon size={11} strokeWidth={3} />}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[13px] font-medium leading-tight">{r.label}</span>
                          <span className={`block text-[11px] leading-tight mt-0.5 ${selected ? "text-[var(--color-muted)]" : "text-[var(--color-muted-2)]"}`}>{r.hint}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="text-[11px] text-[var(--color-muted)] mt-1">
                  Pulled as a Docker image. Both get the CircleChat MCP + skill wired in.
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Inference provider</div>
                <select
                  value={providerId}
                  onChange={(e) => changeProvider(e.target.value as typeof providerId)}
                  className="cc-select"
                >
                  {PROVIDERS
                    .filter((p) => runtime === "hermes" || p.id !== "nous")
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                </select>
                <div className="text-[11.5px] text-[var(--color-muted)] mt-1">{provider.hint}</div>
              </div>

              {providerId === "custom:freeapi" && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">
                    Base URL <span className="text-[var(--color-muted-2)] normal-case">— where your FreeLLMAPI is running</span>
                  </div>
                  <input
                    value={apiBaseUrl}
                    onChange={(e) => setApiBaseUrl(e.target.value)}
                    placeholder="http://localhost:3200/v1"
                    className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] font-mono"
                  />
                  <div className="text-[11.5px] text-[var(--color-muted)] mt-1">
                    Running on this Pi? Use <code className="font-mono">http://localhost:3200/v1</code>.{" "}
                    <a
                      href="https://github.com/tashfeenahmed/freellmapi"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--color-accent-blue)] underline"
                    >
                      Don't have it?
                    </a>
                  </div>
                </div>
              )}

              <div>
                <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">
                  {providerId === "custom:freeapi"
                    ? "Unified key — freellmapi-… token from the Keys page"
                    : "API key"}
                </div>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider.placeholder}
                  className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] font-mono"
                />
              </div>

              {providerId !== "custom:freeapi" && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Model</div>
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={provider.defaultModel || "(provider default)"}
                    className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] font-mono"
                  />
                </div>
              )}
            </div>

            {err && <p className="text-[12px] text-[var(--color-err)] mt-3">{err}</p>}

            <div className="flex justify-between items-center mt-5">
              <button type="button" onClick={skip} className="text-[13px] text-[var(--color-muted)]">
                Skip for now
              </button>
              <button
                type="submit"
                disabled={
                  busy ||
                  !agentName ||
                  agentHandle.length < 2 ||
                  apiKey.length < 10 ||
                  (providerId === "custom:freeapi" && apiBaseUrl.trim().length < 10)
                }
                className="bg-[var(--color-ink)] text-white rounded py-2 px-4 text-[13px] font-medium disabled:opacity-60"
              >
                {busy ? "Installing…" : "Install agent"}
              </button>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] mt-4">
              Already hosting an agent elsewhere?{" "}
              <button type="button" onClick={skip} className="text-[var(--color-accent-blue)] underline">
                Connect it from Members
              </button>{" "}
              after signup.
            </p>
          </form>
        )}

        <p className="text-[12px] text-[var(--color-muted)] mt-6 text-center">
          Already have an account? <Link to="/login" className="text-[var(--color-accent-blue)]">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
