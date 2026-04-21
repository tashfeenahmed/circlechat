import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api/client";
import { humanizeError } from "../api/errors";
import { useQueryClient } from "@tanstack/react-query";

interface InviteInfo {
  email: string;
  workspace: { id: string; name: string; handle: string } | null;
  viewer: { userId: string; email: string; alreadyMember: boolean } | null;
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    if (!token) return;
    api.get<InviteInfo>(`/invite/${token}`).then(
      (r) => setInfo(r),
      (e) => setErr(humanizeError(e)),
    );
  }, [token]);

  async function submitSignup(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.post("/auth/accept-invite", { token, name, handle, password });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/", { replace: true });
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function joinAsSelf() {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/auth/accept-invite-as-self", { token });
      await qc.invalidateQueries({ queryKey: ["me"] });
      await qc.invalidateQueries({ queryKey: ["workspaces"] });
      nav("/", { replace: true });
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const viewer = info?.viewer;
  const ws = info?.workspace;

  return (
    <div className="min-h-screen grid place-items-center px-6 py-12 bg-[var(--color-bg-2)]">
      <div className="w-full max-w-[440px] bg-white border border-[var(--color-hair-2)] rounded p-8 shadow-sm">
        <div className="brand text-[22px] leading-none mb-1">Circle</div>
        <h1 className="text-[18px] font-semibold mb-1">
          {ws ? `Join ${ws.name}` : "Join workspace"}
        </h1>
        {info && (
          <p className="text-[13px] text-[var(--color-muted)] mb-4">
            Invitation for <b className="text-[var(--color-ink)]">{info.email}</b>
            {ws && (
              <> · workspace <span className="font-mono">@{ws.handle}</span></>
            )}
          </p>
        )}
        {err && <p className="text-[12px] text-[var(--color-err)] mb-2">{err}</p>}

        {/* ── Already logged in ── */}
        {viewer && viewer.alreadyMember && (
          <div className="space-y-3">
            <p className="text-[13px] text-[var(--color-muted)]">
              You're already a member of this workspace as{" "}
              <b className="text-[var(--color-ink)]">{viewer.email}</b>.
            </p>
            <Link
              to="/"
              className="block w-full bg-[var(--color-ink)] text-white rounded py-2 text-center text-[13px] font-medium"
            >
              Go to workspace
            </Link>
          </div>
        )}
        {viewer && !viewer.alreadyMember && (
          <div className="space-y-3">
            <p className="text-[13px] text-[var(--color-muted)]">
              Signed in as <b className="text-[var(--color-ink)]">{viewer.email}</b>.
              {viewer.email !== info?.email && (
                <> The invite was addressed to <b>{info?.email}</b>, but you can join with this account.</>
              )}
            </p>
            <button
              onClick={joinAsSelf}
              disabled={busy}
              className="w-full bg-[var(--color-ink)] text-white rounded py-2 text-[13px] font-medium"
            >
              {busy ? "Joining…" : `Join ${ws?.name ?? "workspace"}`}
            </button>
            <p className="text-[12px] text-[var(--color-muted)] text-center">
              Want to sign up a different account instead?{" "}
              <button
                type="button"
                onClick={async () => {
                  await api.post("/auth/logout");
                  await qc.invalidateQueries({ queryKey: ["me"] });
                  location.reload();
                }}
                className="underline"
              >
                Sign out
              </button>
            </p>
          </div>
        )}

        {/* ── Not logged in — classic signup path ── */}
        {info && !viewer && (
          <form onSubmit={submitSignup} className="space-y-3">
            <input
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
              type="password"
              placeholder="Password (8+ chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-[var(--color-ink)] text-white rounded py-2 text-[13px] font-medium"
            >
              {busy ? "Joining…" : "Join workspace"}
            </button>
            <p className="text-[12px] text-[var(--color-muted)] text-center pt-1">
              Already have an account? <Link to="/login" className="underline">Sign in</Link>
              {" "}first, then reopen this invite link.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
