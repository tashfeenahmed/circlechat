import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  members,
  messages,
  conversationMembers,
  memoryBlocks,
  users,
} from "../db/schema.js";
import { redis } from "./redis.js";
import { chat, plannerEnabled } from "./completion.js";

// Sleep-time compute (Letta): a cheap background pass that keeps the SHARED
// team memory block current without an agent spending a turn on it. Per
// workspace, on a cooldown, it digests recent chatter since a watermark and
// REWRITES the team block (rewrite, not append — so re-processing the same
// window can't duplicate lines and the block self-trims). Opt-in
// (CC_MEMORY_JANITOR=on), fail-safe, and a no-op when there's little new
// activity or the model declines to change anything.

const COOLDOWN_MS = 30 * 60 * 1000; // at most one sweep per workspace per 30 min
const MIN_NEW_MESSAGES = 8; // don't burn an LLM call on a quiet workspace
const MAX_DIGEST_MESSAGES = 60;
const SENTINEL_NO_CHANGE = "NO_CHANGE";

export function janitorEnabled(): boolean {
  return process.env.CC_MEMORY_JANITOR === "on" && plannerEnabled();
}

// Decide whether the model's output should replace the block. Pure/exported for
// tests: reject the no-change sentinel, empty output, and anything over budget.
export function acceptJanitorOutput(
  raw: string,
  charLimit: number,
): { accept: false } | { accept: true; value: string } {
  const v = (raw || "").trim();
  if (!v) return { accept: false };
  if (v.toUpperCase().includes(SENTINEL_NO_CHANGE)) return { accept: false };
  if (v.length > charLimit) return { accept: true, value: v.slice(0, charLimit) };
  return { accept: true, value: v };
}

export async function runMemoryJanitor(): Promise<void> {
  if (!janitorEnabled()) return;

  // Workspaces that have at least one agent (others have no team block to tend).
  const wsRows = await db
    .selectDistinct({ workspaceId: agents.workspaceId })
    .from(agents);
  for (const { workspaceId } of wsRows) {
    await sweepWorkspace(workspaceId).catch((e) =>
      console.error(`[memory-janitor] ${workspaceId} failed`, (e as Error).message),
    );
  }
}

async function sweepWorkspace(workspaceId: string): Promise<void> {
  // Cooldown via a redis NX lock — survives restarts, no schema needed.
  const lock = await redis.set(`cc:memjanitor:lock:${workspaceId}`, "1", "PX", COOLDOWN_MS, "NX");
  if (lock !== "OK") return;

  const teamBlockId = `mbt_${workspaceId}`.slice(0, 40);
  const [block] = await db.select().from(memoryBlocks).where(eq(memoryBlocks.id, teamBlockId)).limit(1);
  if (!block) return; // no agent has triggered block creation yet

  // Watermark: only digest messages newer than the last sweep.
  const wmKey = `cc:memjanitor:wm:${workspaceId}`;
  const wmRaw = await redis.get(wmKey);
  const since = wmRaw ? new Date(wmRaw) : new Date(Date.now() - COOLDOWN_MS);

  const recent = await recentWorkspaceMessages(workspaceId, since);
  if (recent.length < MIN_NEW_MESSAGES) {
    // Not enough new signal — advance the watermark so we don't re-scan it, and bail.
    if (recent.length) await redis.set(wmKey, recent[recent.length - 1].ts.toISOString());
    return;
  }

  const digest = recent
    .map((m) => `${m.handle}: ${m.body.replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n")
    .slice(0, 6000);

  const out = await chat(
    [
      {
        role: "system",
        content:
          "You maintain a SHARED team whiteboard — a short, durable summary of the project's current " +
          "state, key decisions, and who is working on what, read by every AI teammate. You are given " +
          "the CURRENT whiteboard and a digest of RECENT activity. Produce the UPDATED whiteboard: fold " +
          "in anything materially new, drop what's stale, keep it tight and factual (no chit-chat, no " +
          "speculation). Stay well under " + block.charLimit + " characters. If nothing material " +
          `changed, reply with exactly "${SENTINEL_NO_CHANGE}" and nothing else. Output ONLY the ` +
          "whiteboard text (or the sentinel) — no preamble, no markdown fences.",
      },
      {
        role: "user",
        content:
          `CURRENT WHITEBOARD:\n${block.value || "(empty)"}\n\n` +
          `RECENT ACTIVITY (oldest first):\n${digest}`,
      },
    ],
    { temperature: 0, maxTokens: 800, timeoutMs: 60_000 },
  ).catch(() => null);

  // Always advance the watermark to the newest message we considered, even if
  // we don't write — otherwise a declined sweep re-digests the same window.
  await redis.set(wmKey, recent[recent.length - 1].ts.toISOString());

  if (!out) return;
  const decision = acceptJanitorOutput(out, block.charLimit);
  if (!decision.accept) return;
  if (decision.value.trim() === block.value.trim()) return;

  await db
    .update(memoryBlocks)
    .set({ value: decision.value, updatedAt: new Date(), updatedBy: null })
    .where(eq(memoryBlocks.id, teamBlockId));
  console.log(`[memory-janitor] updated team block for ${workspaceId} (${decision.value.length} chars)`);
}

// Recent human+agent messages in channels that workspace agents belong to,
// since the watermark, oldest first, capped.
async function recentWorkspaceMessages(
  workspaceId: string,
  since: Date,
): Promise<Array<{ handle: string; body: string; ts: Date }>> {
  // member → handle map for the workspace (agents + users), so the digest reads
  // "rachel: …" not bare text. members is polymorphic, so resolve refIds.
  const memberRows = await db
    .select({ id: members.id, kind: members.kind, refId: members.refId })
    .from(members)
    .where(eq(members.workspaceId, workspaceId));
  const agentMemberIds = memberRows.filter((m) => m.kind === "agent").map((m) => m.id);
  if (!agentMemberIds.length) return [];

  const agentHandles = new Map(
    (await db.select({ id: agents.id, handle: agents.handle }).from(agents).where(eq(agents.workspaceId, workspaceId))).map(
      (a) => [a.id, a.handle],
    ),
  );
  const userIds = memberRows.filter((m) => m.kind === "user").map((m) => m.refId);
  const userHandles = userIds.length
    ? new Map(
        (await db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, userIds))).map((u) => [
          u.id,
          u.handle,
        ]),
      )
    : new Map<string, string>();
  const handleByMember = new Map<string, string>();
  for (const m of memberRows) {
    const h = m.kind === "agent" ? agentHandles.get(m.refId) : userHandles.get(m.refId);
    if (h) handleByMember.set(m.id, h);
  }

  const convRows = await db
    .selectDistinct({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(inArray(conversationMembers.memberId, agentMemberIds));
  const convIds = convRows.map((c) => c.conversationId);
  if (!convIds.length) return [];

  const rows = await db
    .select({ body: messages.bodyMd, ts: messages.ts, memberId: messages.memberId })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, convIds),
        gt(messages.ts, since),
        sql`${messages.deletedAt} is null`,
      ),
    )
    .orderBy(desc(messages.ts))
    .limit(MAX_DIGEST_MESSAGES);
  return rows
    .reverse()
    .map((r) => ({ handle: handleByMember.get(r.memberId) || "someone", body: r.body || "", ts: r.ts }));
}
