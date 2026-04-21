import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus, Trash2, Save, X, Zap, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { api, type DirMember } from "../api/client";
import { useMembersDirectory } from "../lib/hooks";
import Avatar from "../components/Avatar";

interface SkillSummary {
  name: string;
  hasDescription: boolean;
  summary: string | null;
}
interface AgentRow {
  id: string;
  memberId: string;
  name: string;
  handle: string;
  avatarColor: string;
  title: string;
  status: string;
}

export default function SkillsPage() {
  const dir = useMembersDirectory();

  const agents = useMemo<AgentRow[]>(() => {
    const all = (dir.data?.agents ?? []) as DirMember[];
    return all
      .filter((a) => (a as { agentKind?: string }).agentKind === "hermes")
      .map((a) => {
        const aa = a as {
          id: string;
          memberId: string;
          name: string;
          handle: string;
          avatarColor: string;
          title?: string;
          status?: string;
        };
        return {
          id: aa.id,
          memberId: aa.memberId,
          name: aa.name,
          handle: aa.handle,
          avatarColor: aa.avatarColor,
          title: aa.title ?? "",
          status: aa.status ?? "idle",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [dir.data]);

  return (
    <main className="workspace flex-1 min-w-0">
      <header className="chan-head">
        <div className="ch-title inline-flex items-center gap-2">
          <BookOpen size={15} strokeWidth={2} /> Skills
        </div>
        <div className="ch-meta">
          <span>
            {agents.length} agent{agents.length === 1 ? "" : "s"} — only CircleChat-managed skills
            shown (the bundled Hermes pack is hidden).
          </span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {dir.isLoading && (
          <div className="p-8 text-[13px] text-[var(--color-muted)]">Loading…</div>
        )}
        {!dir.isLoading && agents.length === 0 && (
          <div className="p-8 text-[13px] text-[var(--color-muted)]">
            No Hermes agents in this workspace yet.
          </div>
        )}
        <div className="max-w-[960px] mx-auto py-6 px-6 space-y-6">
          {agents.map((a) => (
            <AgentBlock key={a.id} agent={a} />
          ))}
        </div>
      </div>
    </main>
  );
}

function AgentBlock({ agent }: { agent: AgentRow }) {
  const qc = useQueryClient();
  const skills = useQuery({
    queryKey: ["agent-skills", agent.id],
    queryFn: () => api.get<{ skills: SkillSummary[] }>(`/agents/${agent.id}/skills`),
  });
  const [equipping, setEquipping] = useState(false);
  const [equipMsg, setEquipMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = skills.data?.skills ?? [];

  async function equip(): Promise<void> {
    setEquipping(true);
    setEquipMsg(null);
    try {
      const r = await api.post<{ skillInstalled: boolean; mcpRegistered: boolean; notes?: string[] }>(
        `/agents/${agent.id}/equip`,
      );
      setEquipMsg(
        r.skillInstalled && r.mcpRegistered
          ? "Equipped."
          : `Partial (skill=${r.skillInstalled} mcp=${r.mcpRegistered}).`,
      );
      await qc.invalidateQueries({ queryKey: ["agent-skills", agent.id] });
    } catch (e) {
      setEquipMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setEquipping(false);
    }
  }

  return (
    <section className="agent-block">
      <header className="flex items-start gap-3 pb-3 border-b border-[var(--color-hair)]">
        <Avatar name={agent.name} color={agent.avatarColor} agent size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[15px] font-semibold">{agent.name}</span>
            <span className="text-[12px] font-mono text-[var(--color-muted)]">@{agent.handle}</span>
            <span className="tag agent">agent</span>
            {agent.title && (
              <span className="text-[12.5px] text-[var(--color-muted)]">· {agent.title}</span>
            )}
          </div>
          <div className="text-[11.5px] text-[var(--color-muted-2)] mt-0.5">
            {list.length} skill{list.length === 1 ? "" : "s"} managed here
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="btn sm ghost inline-flex items-center gap-1"
            disabled={equipping}
            onClick={equip}
            title="Reinstall the CircleChat skill and re-register the MCP server"
          >
            <Zap size={13} strokeWidth={2} /> {equipping ? "Equipping…" : "Re-equip"}
          </button>
          <button
            className="btn primary sm inline-flex items-center gap-1"
            onClick={() => setAdding(true)}
          >
            <Plus size={13} strokeWidth={2} /> Add skill
          </button>
        </div>
      </header>

      {equipMsg && (
        <div className="mt-2 text-[12px] text-[var(--color-muted)]">{equipMsg}</div>
      )}

      <div className="mt-4 space-y-3">
        {skills.isLoading && (
          <div className="text-[12px] text-[var(--color-muted)]">Loading skills…</div>
        )}
        {!skills.isLoading && list.length === 0 && !adding && (
          <div className="text-[12.5px] text-[var(--color-muted)] border border-dashed border-[var(--color-hair-2)] rounded p-4 text-center">
            No skills yet. Hit <b>Re-equip</b> to install the core <code className="font-mono">circlechat</code> skill, or <b>Add skill</b> to drop in custom markdown.
          </div>
        )}
        {list.map((s) => (
          <SkillCard key={s.name} agentId={agent.id} skill={s} />
        ))}
        {adding && (
          <SkillEditorCard
            agentId={agent.id}
            onDone={() => {
              setAdding(false);
              qc.invalidateQueries({ queryKey: ["agent-skills", agent.id] });
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    </section>
  );
}

function SkillCard({ agentId, skill }: { agentId: string; skill: SkillSummary }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(skill.name === "circlechat");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const full = useQuery({
    queryKey: ["agent-skill", agentId, skill.name],
    queryFn: () => api.get<{ name: string; markdown: string }>(`/agents/${agentId}/skills/${skill.name}`),
    enabled: expanded,
  });

  async function startEdit(): Promise<void> {
    setDraft(full.data?.markdown ?? "");
    setEditing(true);
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await api.put(`/agents/${agentId}/skills/${skill.name}`, { markdown: draft });
      await qc.invalidateQueries({ queryKey: ["agent-skill", agentId, skill.name] });
      await qc.invalidateQueries({ queryKey: ["agent-skills", agentId] });
      setEditing(false);
    } catch (e) {
      alert(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!confirm(`Delete the ${skill.name} skill for this agent?`)) return;
    setBusy(true);
    try {
      await api.del(`/agents/${agentId}/skills/${skill.name}`);
      await qc.invalidateQueries({ queryKey: ["agent-skills", agentId] });
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const isCore = skill.name === "circlechat";

  return (
    <article className="skill-card">
      <button
        type="button"
        className="skill-card-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown size={14} strokeWidth={2} className="text-[var(--color-muted)]" />
        ) : (
          <ChevronRight size={14} strokeWidth={2} className="text-[var(--color-muted)]" />
        )}
        <span className="font-mono text-[13px]">{skill.name}</span>
        {isCore && <span className="tag">core</span>}
        <span className="text-[12px] text-[var(--color-muted)] truncate flex-1 text-left">
          {skill.summary ?? (skill.hasDescription ? "" : "(missing DESCRIPTION.md)")}
        </span>
      </button>
      {expanded && (
        <div className="skill-card-body">
          {!editing ? (
            <>
              <pre className="skill-md">{full.data?.markdown ?? "Loading…"}</pre>
              <div className="skill-actions">
                {!isCore && (
                  <button
                    className="btn sm ghost inline-flex items-center gap-1 hover:text-[var(--color-err)]"
                    onClick={remove}
                    disabled={busy}
                  >
                    <Trash2 size={13} strokeWidth={2} /> Delete
                  </button>
                )}
                <button
                  className="btn sm primary inline-flex items-center gap-1"
                  onClick={startEdit}
                  disabled={!full.data}
                >
                  <Pencil size={13} strokeWidth={2} /> Edit
                </button>
              </div>
            </>
          ) : (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="skill-editor"
                spellCheck={false}
              />
              <div className="skill-actions">
                <button
                  className="btn sm ghost inline-flex items-center gap-1"
                  onClick={() => setEditing(false)}
                  disabled={busy}
                >
                  <X size={13} strokeWidth={2} /> Cancel
                </button>
                <button
                  className="btn sm primary inline-flex items-center gap-1"
                  onClick={save}
                  disabled={busy}
                >
                  <Save size={13} strokeWidth={2} /> {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function SkillEditorCard({
  agentId,
  onDone,
  onCancel,
}: {
  agentId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [markdown, setMarkdown] = useState(
    `---\nname: new-skill\ndescription: >\n  One-paragraph description of when to load this skill.\ntags: []\ntriggers: []\n---\n\n# New skill\n\nWrite the skill here. Keep it focused on a single behaviour or capability.\n`,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(): Promise<void> {
    setErr(null);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      setErr("Name must be alphanumeric with . _ - only.");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/agents/${agentId}/skills/${name}`, { markdown });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="skill-card editing">
      <header className="skill-card-head" style={{ cursor: "default" }}>
        <span className="text-[12px] text-[var(--color-muted)] font-mono">name:</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
          placeholder="my-skill"
          className="border border-[var(--color-hair-2)] rounded px-2 py-0.5 font-mono text-[13px]"
        />
        <div className="ml-auto flex gap-2">
          <button className="btn sm ghost inline-flex items-center gap-1" onClick={onCancel} disabled={busy}>
            <X size={13} strokeWidth={2} /> Cancel
          </button>
          <button
            className="btn sm primary inline-flex items-center gap-1"
            onClick={save}
            disabled={busy || !name}
          >
            <Save size={13} strokeWidth={2} /> {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </header>
      {err && <div className="px-4 py-2 text-[12px] text-[var(--color-err)]">{err}</div>}
      <div className="skill-card-body">
        <textarea
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          className="skill-editor"
          spellCheck={false}
        />
      </div>
    </article>
  );
}
