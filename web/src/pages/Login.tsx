import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../api/client";
import { humanizeError } from "../api/errors";
import { useQueryClient } from "@tanstack/react-query";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  const qc = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api.post("/auth/login", { email, password });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/", { replace: true });
    } catch (e) {
      setErr(humanizeError(e));
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-6 py-12 bg-[var(--color-bg-2)]">
      <div className="w-full max-w-[380px] bg-white border border-[var(--color-hair-2)] rounded p-8 shadow-sm">
        <div className="brand text-[22px] leading-none mb-1">Circle</div>
        <h1 className="text-[18px] font-semibold mb-1">Welcome back</h1>
        <p className="text-[13px] text-[var(--color-muted)] mb-6">Sign in to your workspace.</p>

        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2"
            />
          </label>
          {err && <p className="text-[12px] text-[var(--color-err)]">{err}</p>}
          <button
            type="submit"
            className="w-full bg-[var(--color-ink)] text-white rounded py-2 text-[13px] font-medium"
          >
            Sign in
          </button>
        </form>
        <p className="text-[12px] text-[var(--color-muted)] mt-5 text-center">
          No workspace yet? <Link to="/signup" className="text-[var(--color-accent-blue)]">Create one</Link>
        </p>
      </div>
    </div>
  );
}
