import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, ShieldCheck, UserMinus, Copy, Check, Sun, Moon } from "lucide-react";
import { useMe, useWorkspaceMembers, useInvites, useMembersDirectory } from "../lib/hooks";
import { api } from "../api/client";
import { useTheme, type Theme } from "../lib/theme";

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
    <main className="flex-1 overflow-auto bg-paper">
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

        {ws && isAdmin && <MembersAdminSection workspaceId={ws.id} workspaceHandle={ws.handle} />}

        <section className="border border-[var(--color-hair)] rounded p-4 mb-4">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Notifications</h2>
          <p className="text-[13px] text-[var(--color-muted)]">
            In-app notifications are live — see the bell in the top bar. Browser push and email
            digests are still to come.
          </p>
        </section>

        <section className="border border-[var(--color-hair)] rounded p-4">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Theme</h2>
          <p className="text-[13px] text-[var(--color-muted)] mb-3">
            Choose your appearance. Defaults to your system setting.
          </p>
          <ThemeToggle />
        </section>
      </div>
    </main>
  );
}

// Light/dark appearance picker. Applies + persists immediately via setTheme.
function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const options: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
  ];
  return (
    <div className="inline-flex rounded border border-[var(--color-hair-2)] overflow-hidden">
      {options.map((opt) => {
        const active = theme === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => setTheme(opt.value)}
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-[13px] ${
              active
                ? "bg-[var(--color-ink)] text-[var(--color-paper)]"
                : "text-[var(--color-muted)] hover:bg-[var(--color-hi)]"
            }`}
          >
            <Icon size={14} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Admin-only: manage workspace member roles + removals and pending invites.
function MembersAdminSection({
  workspaceId,
  workspaceHandle,
}: {
  workspaceId: string;
  workspaceHandle: string;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const members = useWorkspaceMembers(workspaceId);
  const invites = useInvites();
  const dir = useMembersDirectory();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Resolve a userId → display name/handle via the directory (which is keyed by
  // memberId, so build a userId index from its `id` field).
  const userIndex = new Map<string, { name: string; handle: string }>();
  for (const h of dir.data?.humans ?? []) userIndex.set(h.id, { name: h.name, handle: h.handle });

  async function changeRole(userId: string, role: "admin" | "member") {
    setErr(null);
    setBusy(userId);
    try {
      await api.patch(`/workspaces/${workspaceId}/members/${userId}`, { role });
      await qc.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
    } catch (e) {
      setErr(humanize((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(userId: string) {
    const who = userIndex.get(userId)?.name ?? "this member";
    if (!confirm(`Remove ${who} from the workspace? They lose all access here.`)) return;
    setErr(null);
    setBusy(userId);
    try {
      await api.del(`/workspaces/${workspaceId}/members/${userId}`);
      await qc.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
    } catch (e) {
      setErr(humanize((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  async function revokeInvite(inviteId: string) {
    if (!confirm("Revoke this invite? The link will stop working.")) return;
    setErr(null);
    setBusy(inviteId);
    try {
      await api.del(`/auth/invites/${inviteId}`);
      await qc.invalidateQueries({ queryKey: ["invites"] });
    } catch (e) {
      setErr(humanize((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  function copyLink(url: string, id: string) {
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
      },
      () => {},
    );
  }

  const memberRows = members.data?.members ?? [];
  const pending = invites.data?.invites ?? [];

  return (
    <section className="border border-[var(--color-hair)] rounded p-4 mb-4">
      <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">
        Members &amp; access
      </h2>
      <p className="text-[13px] text-[var(--color-muted)] mb-3">
        Manage who's in this workspace and their role. Admins can invite, promote, and remove.
      </p>
      {err && <p className="text-[12px] text-[var(--color-err)] mb-2">{err}</p>}

      <ul className="divide-y divide-[var(--color-hair)] border border-[var(--color-hair)] rounded mb-4">
        {memberRows.map((m) => {
          const info = userIndex.get(m.userId);
          const isMe = m.userId === me.data?.user.id;
          return (
            <li key={m.userId} className="px-3 py-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium truncate">
                  {info?.name ?? m.userId}
                  {isMe && <span className="text-[var(--color-muted)] font-normal"> (you)</span>}
                </div>
                <div className="text-[11.5px] font-mono text-[var(--color-muted)] truncate">
                  {info ? `@${info.handle}` : m.userId} · {m.role}
                </div>
              </div>
              <select
                value={m.role}
                disabled={busy === m.userId}
                onChange={(e) => changeRole(m.userId, e.target.value as "admin" | "member")}
                className="border border-[var(--color-hair-2)] rounded px-2 py-1 text-[12px] font-mono"
                title="Change role"
              >
                <option value="admin">admin</option>
                <option value="member">member</option>
              </select>
              {!isMe && (
                <button
                  onClick={() => removeMember(m.userId)}
                  disabled={busy === m.userId}
                  className="btn sm ghost inline-flex items-center gap-1 text-[var(--color-err)]"
                  title="Remove from workspace"
                >
                  <UserMinus size={13} strokeWidth={2} />
                </button>
              )}
            </li>
          );
        })}
        {memberRows.length === 0 && (
          <li className="px-3 py-3 text-[12px] text-[var(--color-muted)]">No members loaded.</li>
        )}
      </ul>

      <h3 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2 inline-flex items-center gap-1">
        <ShieldCheck size={12} strokeWidth={2} /> Pending invites
      </h3>
      {pending.length === 0 ? (
        <p className="text-[12px] text-[var(--color-muted)]">
          No outstanding invites. Invite teammates from the Members page.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-hair)] border border-[var(--color-hair)] rounded">
          {pending.map((inv) => (
            <li key={inv.id} className="px-3 py-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] truncate">{inv.email}</div>
                <div className="text-[11px] font-mono text-[var(--color-muted)] truncate">
                  invited {new Date(inv.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={() => copyLink(inv.inviteUrl, inv.id)}
                className="btn sm ghost inline-flex items-center gap-1"
                title="Copy invite link"
              >
                {copied === inv.id ? (
                  <>
                    <Check size={13} strokeWidth={2} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={13} strokeWidth={2} /> Link
                  </>
                )}
              </button>
              <button
                onClick={() => revokeInvite(inv.id)}
                disabled={busy === inv.id}
                className="btn sm ghost inline-flex items-center gap-1 text-[var(--color-err)]"
                title="Revoke invite"
              >
                <Trash2 size={13} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function humanize(code: string): string {
  const map: Record<string, string> = {
    last_admin: "You can't remove or demote the last admin.",
    admin_only: "Only admins can do that.",
    member_not_found: "That member isn't in this workspace.",
    already_accepted: "That invite was already accepted.",
    not_found: "Not found.",
  };
  return map[code] ?? code;
}
