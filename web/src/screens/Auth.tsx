// SPDX-License-Identifier: AGPL-3.0-only
// First run (create the owner account) and sign in.
import { useState, type CSSProperties, type FormEvent } from "react";
import { api } from "../api.ts";
import { Blob, Icon } from "../ui/ui.tsx";

export function AuthScreen({ setup, workspace, hosted, onDone }: { setup: boolean; workspace: string; hosted?: { signInUrl: string } | null; onDone: () => void }) {
  const expired = new URLSearchParams(location.search).get("signin") === "expired";
  const [f, setF] = useState({ workspace: "", name: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (setup) await api.post("/api/setup", f);
      else await api.post("/api/login", { email: f.email, password: f.password });
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-card">
      <div style={{ padding: "28px 56px", display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <div className="logo" style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 16 }}>
          <span className="logo-mark" />
          CircleChat
        </div>
        <form onSubmit={submit} style={{ margin: "auto 0", maxWidth: 420, width: "100%" }} className="form">
          <div>
            <h1 style={{ fontSize: 44, lineHeight: 1.05, letterSpacing: "-.03em", fontWeight: 700 }}>
              {setup ? (
                <>
                  Set up your
                  <br />
                  team chat.
                </>
              ) : (
                <>
                  A group chat
                  <br />
                  that gets things done.
                </>
              )}
            </h1>
            <p className="muted" style={{ fontSize: 17, margin: "16px 0 14px" }}>
              {setup
                ? "You're the first one here, so you'll be the owner. You can invite people and add agents next."
                : "Chat with a team of AI agents. Each one has its own computer and memory. Runs on your own server."}
            </p>
          </div>
          {setup && (
            <>
              <div>
                <label className="label" htmlFor="ws">
                  Workspace name
                </label>
                <input id="ws" className="input" value={f.workspace} onChange={set("workspace")} placeholder="My team" autoFocus />
              </div>
              <div>
                <label className="label" htmlFor="nm">
                  Your name
                </label>
                <input id="nm" className="input" value={f.name} onChange={set("name")} required />
              </div>
            </>
          )}
          {hosted && !setup && (
            <>
              <a className="btn primary lg" style={{ width: "100%", textDecoration: "none" }} href={hosted.signInUrl}>
                Sign in with CircleChat Cloud
                <Icon n="arrow" />
              </a>
              <p className="small muted" style={{ textAlign: "center" }}>or with this workspace's own password</p>
            </>
          )}
          <div>
            <label className="label" htmlFor="em">
              Email
            </label>
            <input id="em" className="input" type="email" value={f.email} onChange={set("email")} required autoFocus={!setup} autoComplete="email" />
          </div>
          <div>
            <label className="label" htmlFor="pw">
              Password
            </label>
            <input
              id="pw"
              className="input"
              type="password"
              value={f.password}
              onChange={set("password")}
              required
              minLength={setup ? 8 : undefined}
              autoComplete={setup ? "new-password" : "current-password"}
            />
            {setup && <div className="hint">At least 8 characters.</div>}
          </div>
          {expired && !err && <div className="err-msg">That sign-in link has expired. Sign in again.</div>}
          {err && <div className="err-msg">{err}</div>}
          <button className={`btn ${hosted && !setup ? "" : "primary "}lg`} style={{ width: "100%" }} disabled={busy}>
            {setup ? "Create workspace" : "Sign in"}
            <Icon n="arrow" />
          </button>
          <p className="small muted">{setup ? "Your server, your data." : `${workspace || "CircleChat"} · your server, your data`}</p>
        </form>
        <p className="small muted">{hosted ? "CircleChat 2.0 · hosted by CircleChat Cloud in the EU · open source (AGPL-3.0)" : "CircleChat 2.0 · self-hosted · open source (AGPL-3.0)"}</p>
      </div>
      <div className="side" style={{ background: "linear-gradient(180deg,#F4F5F8,#EEF0F6)", margin: 12, borderRadius: 18, display: "grid", placeItems: "center" }}>
        <div style={{ width: 400, display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            ["classic", "coral", "Hi! I keep the team on track."],
            ["twin", "mint", "I find things out on my own browser."],
            ["curly", "butter", "I write. Posts, pages, emails."],
            ["halo", "lilac", "And I check with you before anything risky."],
          ].map(([s, c, t], i) => (
            <div key={i} className="m gap" style={{ "--tint": tint(c) } as CSSProperties}>
              <Blob style={s} colour={c} size={44} />
              <div className="stackm">
                <div className="bub agent tail">{t}</div>
              </div>
            </div>
          ))}
          <div className="m me gap">
            <div className="stackm">
              <div className="bub tail">Nice to meet you all!</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
const tint = (c: string) => ({ coral: "#FFEDE6", mint: "#E2F7EE", butter: "#FFF5D6", lilac: "#EEE8FF" })[c] ?? "#F0F1F5";
