import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "../api/client";

interface Props {
  me: Me;
}

export default function WorkspaceRail({ me }: Props) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function switchTo(id: string): Promise<void> {
    if (id === me.workspaceId) return;
    try {
      await api.post(`/workspaces/${id}/switch`);
      // Invalidate everything — memberId changes, channels/DMs/agents all different.
      await qc.invalidateQueries();
    } catch (e) {
      console.error("switch failed", e);
    }
  }

  async function create(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/workspaces", { name, handle });
      await qc.invalidateQueries();
      setCreating(false);
      setName("");
      setHandle("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="rail">
        {me.workspaces.map((w) => {
          const active = w.id === me.workspaceId;
          return (
            <button
              key={w.id}
              type="button"
              onClick={() => switchTo(w.id)}
              className={`ws-chip ${active ? "active" : ""}`}
              title={`${w.name} (@${w.handle})`}
            >
              {initial(w.name)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ws-alt"
          title="Create a new workspace"
        >
          <Plus size={14} strokeWidth={2.2} />
        </button>
      </div>

      {creating && (
        <div
          className="fixed inset-0 bg-black/30 grid place-items-center z-50"
          onClick={() => !busy && setCreating(false)}
        >
          <div
            className="bg-white rounded-md border border-[var(--color-hair-2)] shadow-lg w-[420px] max-w-[92vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--color-hair)]">
              <div>
                <h2 className="text-[15px] font-semibold">New workspace</h2>
                <p className="text-[12.5px] text-[var(--color-muted)] mt-0.5">
                  You'll be admin; channels, DMs, and agents are scoped to it.
                </p>
              </div>
              <button onClick={() => setCreating(false)} className="tb-btn" title="Close">
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">
                  Name
                </span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!handle)
                      setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""));
                  }}
                  placeholder="Side Project"
                  className="mt-1 w-full border border-[var(--color-hair-2)] rounded px-3 py-2 text-[14px]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono">
                  Handle
                </span>
                <div className="mt-1 flex items-center border border-[var(--color-hair-2)] rounded overflow-hidden">
                  <span className="px-2 text-[var(--color-muted)] font-mono text-[13px]">@</span>
                  <input
                    value={handle}
                    onChange={(e) =>
                      setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))
                    }
                    placeholder="sideproject"
                    className="flex-1 py-2 pr-2 font-mono text-[13px] outline-none"
                  />
                </div>
              </label>
              {err && <p className="text-[12px] text-[var(--color-err)]">{err}</p>}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--color-hair)]">
              <button
                onClick={() => setCreating(false)}
                disabled={busy}
                className="btn sm ghost"
              >
                Cancel
              </button>
              <button
                onClick={create}
                disabled={busy || !name || handle.length < 2}
                className="btn sm primary"
              >
                {busy ? "Creating…" : "Create workspace"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function initial(s: string): string {
  return (s.trim()[0] ?? "?").toUpperCase();
}
