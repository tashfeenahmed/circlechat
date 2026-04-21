import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../api/client";
import { useQueryClient } from "@tanstack/react-query";

export default function SignupPage() {
  const [step, setStep] = useState(0);
  const [workspaceName, setWorkspace] = useState("");
  const [workspaceHandle, setWorkspaceHandle] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  const qc = useQueryClient();

  async function submit() {
    setErr(null);
    try {
      await api.post("/auth/signup", {
        email,
        password,
        name,
        handle,
        workspaceName,
        workspaceHandle: workspaceHandle || workspaceName.toLowerCase().replace(/[^a-z0-9]/g, ""),
      });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/members", { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-6 py-12 bg-[var(--color-bg-2)]">
      <div className="w-full max-w-[460px] bg-white border border-[var(--color-hair-2)] rounded p-8 shadow-sm">
        <div className="brand text-[22px] leading-none mb-1">Circle</div>
        <div className="text-[11px] uppercase tracking-widest text-[var(--color-muted)] mb-5 font-mono">
          Step {step + 1} of 3
        </div>

        {step === 0 && (
          <>
            <h1 className="text-[18px] font-semibold mb-1">Name your workspace</h1>
            <p className="text-[13px] text-[var(--color-muted)] mb-5">You can create more later from the rail.</p>
            <input
              placeholder="Acme Team"
              value={workspaceName}
              onChange={(e) => {
                setWorkspace(e.target.value);
                if (!workspaceHandle)
                  setWorkspaceHandle(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""));
              }}
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 mb-2"
            />
            <div className="flex items-center border border-[var(--color-hair-2)] rounded overflow-hidden mb-3">
              <span className="px-2 text-[var(--color-muted)] font-mono text-[13px]">handle</span>
              <input
                placeholder="acme"
                value={workspaceHandle}
                onChange={(e) =>
                  setWorkspaceHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))
                }
                className="flex-1 py-2 pr-2 font-mono text-[13px] outline-none"
              />
            </div>
            <button
              onClick={() => workspaceName && workspaceHandle.length >= 2 && setStep(1)}
              className="w-full bg-[var(--color-ink)] text-white rounded py-2 text-[13px] font-medium"
            >
              Continue
            </button>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="text-[18px] font-semibold mb-1">Create your account</h1>
            <p className="text-[13px] text-[var(--color-muted)] mb-5">You'll be workspace admin.</p>
            <div className="space-y-3">
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
            <div className="flex justify-between mt-4">
              <button onClick={() => setStep(0)} className="text-[13px] text-[var(--color-muted)]">
                Back
              </button>
              <button
                onClick={() => name && handle && email && password.length >= 8 && setStep(2)}
                className="bg-[var(--color-ink)] text-white rounded py-2 px-4 text-[13px] font-medium"
              >
                Continue
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="text-[18px] font-semibold mb-1">One more step</h1>
            <p className="text-[13px] text-[var(--color-muted)] mb-4">
              We'll create your account and drop you into your workspace. Once you're in, open{" "}
              <span className="font-mono">Members → Add agent</span> to install or attach your first agent
              — you'll be asked whether to run it here on this server or connect one you're already hosting.
            </p>
            {err && <p className="text-[12px] text-[var(--color-err)] mb-2">{err}</p>}
            <div className="flex justify-between">
              <button onClick={() => setStep(1)} className="text-[13px] text-[var(--color-muted)]">
                Back
              </button>
              <button
                onClick={submit}
                className="bg-[var(--color-ink)] text-white rounded py-2 px-4 text-[13px] font-medium"
              >
                Create workspace
              </button>
            </div>
          </>
        )}

        <p className="text-[12px] text-[var(--color-muted)] mt-6 text-center">
          Already have an account? <Link to="/login" className="text-[var(--color-accent-blue)]">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
