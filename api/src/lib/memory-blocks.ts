import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { memoryBlocks, agentMemoryBlocks } from "../db/schema.js";

// Letta-style memory blocks: labeled prose compiled into every agent prompt and
// self-edited by the agent. Two defaults are lazily ensured per agent on first
// read (covers existing agents with no migration backfill needed):
//   • team  — a SHARED block, one per workspace, attached to every agent: the
//     live "team whiteboard" (current project state, decisions, who's on what).
//     Editing it updates the single row, so every teammate sees it next run.
//   • notes — a PRIVATE block per agent: durable working notes across runs.
// Block ids are derived deterministically from the scope so attach is race-free
// (ON CONFLICT DO NOTHING) and all agents in a workspace share one team block.

export interface MemoryBlock {
  label: string;
  blockId: string;
  description: string;
  value: string;
  charLimit: number;
  shared: boolean;
}

const TEAM_DESC =
  "Shared team whiteboard — current project state, key decisions, and who is working on what. " +
  "EVERY agent in this workspace reads and edits this. Keep it the single source of truth so nobody " +
  "re-derives the situation from chat scrollback. Trim stale lines; don't let it sprawl.";
const NOTES_DESC =
  "Your PRIVATE working notes, persisted across runs. Stash what you'll need next time you wake " +
  "(what you were doing, decisions you made, where a file lives). Only you see this.";

const TEAM_CHAR_LIMIT = 3000;
const NOTES_CHAR_LIMIT = 2000;

function teamBlockId(workspaceId: string): string {
  return `mbt_${workspaceId}`.slice(0, 40);
}
function notesBlockId(agentId: string): string {
  return `mbn_${agentId}`.slice(0, 40);
}

// Load an agent's blocks, lazily creating the two defaults the first time.
// Steady state is a single indexed read + join; the ensure path runs only when
// the agent has no rows yet.
export async function ensureAndLoadBlocks(
  agentId: string,
  workspaceId: string,
): Promise<MemoryBlock[]> {
  let rows = await joinLoad(agentId);
  if (rows.length === 0) {
    await ensureDefaults(agentId, workspaceId);
    rows = await joinLoad(agentId);
  }
  return rows;
}

async function ensureDefaults(agentId: string, workspaceId: string): Promise<void> {
  const team = teamBlockId(workspaceId);
  const notes = notesBlockId(agentId);
  await db
    .insert(memoryBlocks)
    .values([
      { id: team, workspaceId, description: TEAM_DESC, value: "", charLimit: TEAM_CHAR_LIMIT, shared: true },
      { id: notes, workspaceId, description: NOTES_DESC, value: "", charLimit: NOTES_CHAR_LIMIT, shared: false },
    ])
    .onConflictDoNothing();
  await db
    .insert(agentMemoryBlocks)
    .values([
      { agentId, label: "team", blockId: team },
      { agentId, label: "notes", blockId: notes },
    ])
    .onConflictDoNothing();
}

async function joinLoad(agentId: string): Promise<MemoryBlock[]> {
  const links = await db
    .select({ label: agentMemoryBlocks.label, blockId: agentMemoryBlocks.blockId })
    .from(agentMemoryBlocks)
    .where(eq(agentMemoryBlocks.agentId, agentId));
  if (links.length === 0) return [];
  const blocks = await db
    .select()
    .from(memoryBlocks)
    .where(inArray(memoryBlocks.id, links.map((l) => l.blockId)));
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const out: MemoryBlock[] = [];
  for (const l of links) {
    const b = byId.get(l.blockId);
    if (!b) continue;
    out.push({
      label: l.label,
      blockId: b.id,
      description: b.description,
      value: b.value,
      charLimit: b.charLimit,
      shared: b.shared,
    });
  }
  // Stable order: team first, then notes, then any others alphabetically.
  const rank = (lbl: string) => (lbl === "team" ? 0 : lbl === "notes" ? 1 : 2);
  out.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
  return out;
}

export type BlockEditOp =
  | { op: "append"; text: string }
  | { op: "rethink"; value: string };

// Compute the new block value for an edit op. Pure — exported for tests.
// Returns the string to store, or an error code/message for the agent.
export function applyBlockEdit(
  current: string,
  charLimit: number,
  edit: BlockEditOp,
): { value: string } | { error: string } {
  let next: string;
  if (edit.op === "append") {
    const text = (edit.text ?? "").trim();
    if (!text) return { error: "memory_append: text is empty — nothing to add." };
    next = current.trim() ? `${current.trim()}\n${text}` : text;
  } else {
    next = (edit.value ?? "").trim();
  }
  if (next.length > charLimit) {
    return {
      error:
        `memory block is over its ${charLimit}-char limit (${next.length}). ` +
        `Trim it: use memory_rethink to rewrite the block more concisely, keeping only what still matters.`,
    };
  }
  return { value: next };
}

// Apply an edit to one of the agent's labeled blocks. Resolves the label →
// block (shared blocks update the single shared row), enforces the char limit,
// and records who edited. Returns null on success or an error message.
export async function editAgentBlock(
  agentId: string,
  workspaceId: string,
  actorMemberId: string,
  label: string,
  edit: BlockEditOp,
): Promise<string | null> {
  // Ensure defaults exist so an agent can edit "team"/"notes" on its first turn.
  await ensureAndLoadBlocks(agentId, workspaceId);
  const [link] = await db
    .select({ blockId: agentMemoryBlocks.blockId })
    .from(agentMemoryBlocks)
    .where(and(eq(agentMemoryBlocks.agentId, agentId), eq(agentMemoryBlocks.label, label)))
    .limit(1);
  if (!link) {
    return `no memory block labeled "${label}". Your blocks are "team" (shared) and "notes" (private).`;
  }
  const [block] = await db
    .select()
    .from(memoryBlocks)
    .where(eq(memoryBlocks.id, link.blockId))
    .limit(1);
  if (!block) return `memory block "${label}" is missing.`;

  const result = applyBlockEdit(block.value, block.charLimit, edit);
  if ("error" in result) return result.error;

  await db
    .update(memoryBlocks)
    .set({ value: result.value, updatedAt: new Date(), updatedBy: actorMemberId })
    .where(eq(memoryBlocks.id, block.id));
  return null;
}
