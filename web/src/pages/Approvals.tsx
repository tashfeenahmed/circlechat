import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, X, ShieldAlert, KeyRound, Plus, Trash2 } from "lucide-react";
import { useApprovals, useAgents, useSpectator } from "../lib/hooks";
import { api } from "../api/client";
import Avatar from "../components/Avatar";
import { useQueryClient } from "@tanstack/react-query";

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// Requests that ask for a credential. Approving one of these WITHOUT attaching
// a secret delivers nothing — the agent reads "approved", finds no value in its
// environment, and the dependent work stays stuck (observed: a task deadlocked
// for 10 days this way). Mirror of the bridge-side detector.
const CREDENTIAL_ASK_RE = /credential|token|api.?key|secret|password|passphrase|access.?key/i;

type SecretRow = { name: string; value: string };

export default function ApprovalsPage() {
  const approvalsQ = useApprovals();
  const agentsQ = useAgents();
  const spectator = useSpectator();
  const qc = useQueryClient();
  const [working, setWorking] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Optional per-approval comment delivered to the agent with the decision.
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Optional per-approval secrets (env-var name + value) installed into the
  // agent's environment on approve. Values never appear in the DB or chat.
  const [secrets, setSecrets] = useState<Record<string, SecretRow[]>>({});

  const agentById = useMemo(() => {
    const m = new Map<string, { name: string; handle: string; avatarColor: string; id: string }>();
    for (const a of agentsQ.data?.agents ?? []) m.set(a.id, a);
    return m;
  }, [agentsQ.data]);

  const rows = approvalsQ.data?.approvals ?? [];

  function setSecretRow(apId: string, i: number, patch: Partial<SecretRow>) {
    setSecrets((s) => {
      const list = [...(s[apId] ?? [])];
      list[i] = { ...list[i], ...patch };
      return { ...s, [apId]: list };
    });
  }

  function secretsValid(apId: string): boolean {
    const list = (secrets[apId] ?? []).filter((r) => r.name || r.value);
    return list.every((r) => SECRET_NAME_RE.test(r.name) && r.value.length > 0);
  }

  async function decide(id: string, decision: "approve" | "deny") {
    setErr(null);
    setWorking(id);
    try {
      const note = (notes[id] ?? "").trim();
      const secretRows = (secrets[id] ?? []).filter((r) => r.name && r.value);
      const secretMap: Record<string, string> = {};
      for (const r of secretRows) secretMap[r.name] = r.value;
      await api.post(`/approvals/${id}`, {
        decision,
        ...(note ? { note } : {}),
        ...(decision === "approve" && secretRows.length ? { secrets: secretMap } : {}),
      });
      setNotes((n) => {
        const { [id]: _gone, ...rest } = n;
        return rest;
      });
      setSecrets((s) => {
        const { [id]: _gone, ...rest } = s;
        return rest;
      });
      await qc.invalidateQueries({ queryKey: ["approvals"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2">
          <ShieldAlert size={15} strokeWidth={2} /> Approvals
        </div>
        <div className="ch-meta">
          <span>{rows.length} pending</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {err && <div className="px-6 py-2 text-[12px] text-[var(--color-err)]">{err}</div>}
        {rows.length === 0 && (
          <div className="px-6 py-16 text-center text-[13px] text-[var(--color-muted)]">
            Nothing to review. Agents will request approval here when they need
            to do something above their current scope.
          </div>
        )}
        <ul className="divide-y divide-[var(--color-hair)]">
          {rows.map((ap) => {
            const ag = agentById.get(ap.agentId);
            const busy = working === ap.id;
            const secretRows = secrets[ap.id] ?? [];
            const valid = secretsValid(ap.id);
            const asksForCreds = CREDENTIAL_ASK_RE.test(`${ap.scope} ${ap.action}`);
            const hasAttachedSecret = secretRows.some((r) => r.name && r.value);
            return (
              <li key={ap.id} className="px-6 py-4 flex gap-4">
                {ag ? (
                  <Link to={`/agents/${ag.id}`} className="shrink-0">
                    <Avatar name={ag.name} color={ag.avatarColor} agent size="md" />
                  </Link>
                ) : (
                  <div className="shrink-0 w-[38px] h-[38px]" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[14px] font-semibold">{ag?.name ?? "unknown agent"}</span>
                    {ag && (
                      <Link to={`/agents/${ag.id}`} className="text-[12px] font-mono text-[var(--color-muted)]">
                        @{ag.handle}
                      </Link>
                    )}
                    <span className="tag">{ap.scope}</span>
                  </div>
                  <div className="text-[13px] mt-1">{ap.action}</div>
                  {!spectator && asksForCreds && !hasAttachedSecret && (
                    <div className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-[var(--color-warn,#b45309)]">
                      <KeyRound size={12} strokeWidth={2} />
                      This asks for a credential. Attach the secret below so it lands in the
                      agent&apos;s environment — approving without one delivers nothing and the
                      work stays stuck. No credential to give? Deny with a note.
                    </div>
                  )}
                  {/* The raw payload can carry request specifics that aren't for a
                      public audience — only the workspace's own reviewers see it. */}
                  {!spectator && Object.keys(ap.payloadJson ?? {}).length > 0 && (
                    <pre className="mt-2 bg-[var(--color-bg-2)] border border-[var(--color-hair)] rounded p-2 text-[11.5px] font-mono overflow-auto max-h-40">
{JSON.stringify(ap.payloadJson, null, 2)}
                    </pre>
                  )}
                  <div className="text-[11.5px] text-[var(--color-muted-2)] mt-2 font-mono">
                    requested {new Date(ap.createdAt).toLocaleString()}
                  </div>
                  {!spectator && (
                    <>
                  <input
                    type="text"
                    value={notes[ap.id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [ap.id]: e.target.value }))}
                    placeholder="Optional note to the agent — sent with your decision…"
                    maxLength={2000}
                    disabled={busy}
                    className="mt-2 w-full max-w-xl text-[12.5px] bg-[var(--color-bg-2)] border border-[var(--color-hair)] rounded px-2 py-1.5 outline-none focus:border-[var(--color-accent)] placeholder:text-[var(--color-muted-2)]"
                  />

                  {/* Secrets: install credentials in the agent's env on approve.
                      The value goes straight to the agent home's .env — it is
                      never stored in the DB, shown in chat, or echoed back. */}
                  <div className="mt-2 max-w-xl">
                    {secretRows.map((r, i) => (
                      <div key={i} className="flex gap-2 mt-1.5 items-center">
                        <input
                          type="text"
                          value={r.name}
                          onChange={(e) =>
                            setSecretRow(ap.id, i, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })
                          }
                          placeholder="ENV_VAR_NAME"
                          maxLength={64}
                          disabled={busy}
                          className={`w-48 text-[12px] font-mono bg-[var(--color-bg-2)] border rounded px-2 py-1.5 outline-none focus:border-[var(--color-accent)] placeholder:text-[var(--color-muted-2)] ${r.name && !SECRET_NAME_RE.test(r.name) ? "border-[var(--color-err)]" : "border-[var(--color-hair)]"}`}
                        />
                        <input
                          type="password"
                          value={r.value}
                          onChange={(e) => setSecretRow(ap.id, i, { value: e.target.value })}
                          placeholder="secret value"
                          maxLength={4096}
                          disabled={busy}
                          autoComplete="off"
                          className="flex-1 text-[12px] font-mono bg-[var(--color-bg-2)] border border-[var(--color-hair)] rounded px-2 py-1.5 outline-none focus:border-[var(--color-accent)] placeholder:text-[var(--color-muted-2)]"
                        />
                        <button
                          onClick={() =>
                            setSecrets((s) => ({ ...s, [ap.id]: (s[ap.id] ?? []).filter((_, j) => j !== i) }))
                          }
                          disabled={busy}
                          className="btn sm ghost"
                          title="Remove secret"
                        >
                          <Trash2 size={13} strokeWidth={2} />
                        </button>
                      </div>
                    ))}
                    {secretRows.length < 10 && (
                      <button
                        onClick={() =>
                          setSecrets((s) => ({ ...s, [ap.id]: [...(s[ap.id] ?? []), { name: "", value: "" }] }))
                        }
                        disabled={busy}
                        className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                        title="Attach a credential — installed into the agent's environment on approve, never shown in chat"
                      >
                        {secretRows.length ? <Plus size={12} strokeWidth={2} /> : <KeyRound size={12} strokeWidth={2} />}
                        {secretRows.length ? "Add another secret" : "Attach secret (env var) on approve…"}
                      </button>
                    )}
                  </div>
                    </>
                  )}
                </div>
                {!spectator && (
                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={() => {
                      if (
                        asksForCreds &&
                        !hasAttachedSecret &&
                        !window.confirm(
                          "This request asks for a credential, but no secret is attached.\n\n" +
                            "Approving delivers NOTHING to the agent — it still won't have the credential and the dependent work stays stuck.\n\n" +
                            "Approve anyway? (Cancel to go back and attach the secret, or deny with a note.)",
                        )
                      )
                        return;
                      decide(ap.id, "approve");
                    }}
                    disabled={busy || !valid}
                    title={valid ? undefined : "Fix the secret rows: name must be ENV_VAR shaped and value non-empty"}
                    className="btn sm primary inline-flex items-center gap-1"
                  >
                    <Check size={13} strokeWidth={2} /> Approve
                  </button>
                  <button
                    onClick={() => decide(ap.id, "deny")}
                    disabled={busy}
                    className="btn sm ghost inline-flex items-center gap-1"
                  >
                    <X size={13} strokeWidth={2} /> Deny
                  </button>
                </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
