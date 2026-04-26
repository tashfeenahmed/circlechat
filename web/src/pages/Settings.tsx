import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMe } from "../lib/hooks";
import { api } from "../api/client";

export default function SettingsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const ws = me.data?.workspaces.find((w) => w.id === me.data?.workspaceId);
  const isAdmin = ws?.role === "admin";

  const [mission, setMission] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (ws) setMission(ws.mission ?? "");
  }, [ws?.id, ws?.mission]);

  async function save() {
    if (!ws) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api.patch(`/workspaces/${ws.id}`, { mission });
      await qc.invalidateQueries({ queryKey: ["me"] });
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message ?? "save_failed");
    } finally {
      setBusy(false);
    }
  }

  const dirty = ws ? mission !== (ws.mission ?? "") : false;

  return (
    <main className="flex-1 overflow-auto bg-white">
      <div className="max-w-[640px] mx-auto px-8 py-8">
        <h1 className="text-[22px] font-semibold mb-1">Settings</h1>
        <p className="text-[13px] text-[var(--color-muted)] mb-6">
          Profile, workspace, and notification preferences.
        </p>

        <section className="border border-[var(--color-hair)] rounded p-4 mb-4">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Profile</h2>
          {me.data && (
            <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-[13px]">
              <dt className="text-[var(--color-muted)]">Name</dt>
              <dd>{me.data.user.name}</dd>
              <dt className="text-[var(--color-muted)]">Handle</dt>
              <dd className="font-mono">@{me.data.user.handle}</dd>
              <dt className="text-[var(--color-muted)]">Email</dt>
              <dd>{me.data.user.email}</dd>
            </dl>
          )}
        </section>

        {ws && (
          <section className="border border-[var(--color-hair)] rounded p-4 mb-4">
            <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">
              Workspace mission
            </h2>
            <p className="text-[13px] text-[var(--color-muted)] mb-3">
              Inherited by every agent in <strong>{ws.name}</strong>. Tell them what you build, who
              the product serves, and any name disambiguations they should know. Agents inherit this
              automatically — no per-agent repetition needed.
            </p>
            <textarea
              rows={5}
              value={mission}
              disabled={!isAdmin || busy}
              onChange={(e) => setMission(e.target.value)}
              placeholder={
                isAdmin
                  ? "e.g. We build CircleChat — a chat workspace where humans and AI agents collaborate as teammates. CircleChat is the product; Hermes is our agent runtime — never confuse the two."
                  : "Only workspace admins can edit the mission."
              }
              className="w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[13px] leading-relaxed font-mono"
              maxLength={2000}
            />
            <div className="flex items-center justify-between mt-2 text-[12px] text-[var(--color-muted)]">
              <span>{mission.length}/2000</span>
              {isAdmin && (
                <div className="flex items-center gap-3">
                  {err && <span className="text-red-600">{err}</span>}
                  {saved && !dirty && <span className="text-green-700">Saved.</span>}
                  <button
                    onClick={save}
                    disabled={!dirty || busy}
                    className="btn sm primary disabled:opacity-40"
                  >
                    {busy ? "Saving…" : "Save mission"}
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="border border-[var(--color-hair)] rounded p-4 mb-4">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Notifications</h2>
          <p className="text-[13px] text-[var(--color-muted)]">
            Browser notifications and email digests ship in M3.
          </p>
        </section>

        <section className="border border-[var(--color-hair)] rounded p-4">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Theme</h2>
          <p className="text-[13px] text-[var(--color-muted)]">Light theme · Notion-gray palette (MVP).</p>
        </section>
      </div>
    </main>
  );
}
