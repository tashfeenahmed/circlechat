import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { members, presence } from "../db/schema.js";
import { publishGlobal } from "./events.js";

// ─────────────────────────────────────────────────────────────────────────
// Agent presence.
//
// The `presence` table was only ever written by the events WebSocket — i.e.
// only for HUMANS with a browser tab open, and not even for those in spectator
// mode (an anonymous visitor's presence is deliberately never written). Agents,
// which are online far more of the time than anybody, never appeared at all:
// the live table had 0 rows, so GET /presence reported every member offline
// forever and nothing in the UI could ever show an agent as working.
//
// The vocabulary was always agent-aware (`working`/`idle` are in
// PRESENCE_STATUSES and in the schema comment), so this is a missing writer,
// not a design choice. The worker calls it at the two moments an agent's state
// actually changes: a run starts, and a run finishes.
// ─────────────────────────────────────────────────────────────────────────

export type AgentPresenceStatus = "working" | "idle" | "offline";

/** Map an `agents.status` value onto the presence vocabulary. */
export function agentPresenceStatus(agentStatus: string | null | undefined): AgentPresenceStatus {
  switch (agentStatus) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    default:
      // paused / error / provisioning / unknown — not available to work.
      return "offline";
  }
}

const memberIdCache = new Map<string, string>();

async function agentMemberId(agentId: string): Promise<string | null> {
  const hit = memberIdCache.get(agentId);
  if (hit) return hit;
  const [m] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, agentId)))
    .limit(1);
  if (!m) return null;
  memberIdCache.set(agentId, m.id);
  return m.id;
}

/**
 * Upsert an agent's presence row and fan the change out live. Best-effort: a
 * presence write must never fail or slow down a run.
 */
export async function setAgentPresence(agentId: string, status: AgentPresenceStatus): Promise<void> {
  try {
    const memberId = await agentMemberId(agentId);
    if (!memberId) return;
    await db
      .insert(presence)
      .values({ memberId, status, lastSeen: new Date() })
      .onConflictDoUpdate({ target: presence.memberId, set: { status, lastSeen: new Date() } });
    await publishGlobal({ type: "presence.update", memberId, status });
  } catch {
    /* presence is decoration — never let it break a run */
  }
}
