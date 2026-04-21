import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  members,
  conversations,
  conversationMembers,
  messages,
} from "../db/schema.js";
import { enqueueAgentEvent } from "./enqueue.js";

// Background "water-cooler" loop: picks one random active agent + one of
// their channels every MIN..MAX minutes and enqueues an `ambient` trigger.
// The agent is free to post a casual note, loop in a colleague, or reply
// HEARTBEAT_OK. A per-agent cooldown prevents the same handle from firing
// twice in quick succession.
//
// Tuned to feel like a lived-in team but NOT like a chat bot farm: one tick
// across the whole deployment every ~18 min (plus jitter), and any single
// agent can't fire more than once every 15 min. Most ticks pick a different
// agent anyway; the cooldown only matters on pool sizes of 1–2.

const TICK_MIN_MS = Number(process.env.AMBIENT_TICK_MIN_MS ?? 15 * 60 * 1000);
const TICK_MAX_MS = Number(process.env.AMBIENT_TICK_MAX_MS ?? 25 * 60 * 1000);
const PER_AGENT_COOLDOWN_MS = Number(process.env.AMBIENT_AGENT_COOLDOWN_MS ?? 15 * 60 * 1000);
// Skip the tick entirely if the chosen channel has had any message in the
// last CHANNEL_QUIET_MS window — active humans don't want ambient noise
// piled on top.
const CHANNEL_QUIET_MS = Number(process.env.AMBIENT_CHANNEL_QUIET_MS ?? 6 * 60 * 1000);

const lastFiredByAgent = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

export function startAmbientChatter(): void {
  if (timer) return;
  const loop = (): void => {
    tick().catch(() => { /* swallowed — next tick will try again */ });
    const delay = TICK_MIN_MS + Math.floor(Math.random() * (TICK_MAX_MS - TICK_MIN_MS));
    timer = setTimeout(loop, delay);
  };
  // First tick has its own jitter so we don't all-fire-at-boot.
  timer = setTimeout(loop, 30_000 + Math.floor(Math.random() * 60_000));
}

export function stopAmbientChatter(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  // Pool of agents that are idle/working (skip paused/error/provisioning).
  // Stable ordering so randomness comes from selection, not DB variance.
  const pool = await db
    .select({
      agentId: agents.id,
      workspaceId: agents.workspaceId,
      memberId: members.id,
      handle: agents.handle,
    })
    .from(agents)
    .innerJoin(
      members,
      and(eq(members.workspaceId, agents.workspaceId), eq(members.kind, "agent"), eq(members.refId, agents.id)),
    )
    .where(dsql`${agents.status} IN ('idle', 'working')` as never)
    .orderBy(agents.id);

  if (!pool.length) return;

  const now = Date.now();
  const eligible = pool.filter((p) => (now - (lastFiredByAgent.get(p.agentId) ?? 0)) >= PER_AGENT_COOLDOWN_MS);
  if (!eligible.length) return;

  const chosen = eligible[Math.floor(Math.random() * eligible.length)]!;

  // Pick a channel this agent is in, preferring channels with recent activity
  // so the ambient post lands somewhere with context rather than in a dead one.
  const channels = await db
    .select({
      id: conversations.id,
      lastTs: dsql<Date | null>`max(${messages.ts})`.as("last_ts"),
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversationMembers.memberId, chosen.memberId),
        eq(conversations.kind, "channel"),
        eq(conversations.archived, false),
        eq(conversations.workspaceId, chosen.workspaceId),
      ),
    )
    .groupBy(conversations.id)
    .orderBy(desc(dsql`max(${messages.ts})`));

  if (!channels.length) return;

  // Weighted pick: top-3 most recent channels get 70% of the probability,
  // the rest distribute the remaining 30%.
  const top = channels.slice(0, 3);
  const tail = channels.slice(3);
  const bucket = Math.random() < 0.7 || tail.length === 0 ? top : tail;
  const picked = bucket[Math.floor(Math.random() * bucket.length)]!;

  // Don't pile ambient on top of active human conversation — if the channel
  // just saw a message, sit this tick out. The loop will try a different
  // channel next cycle.
  const lastTs = picked.lastTs instanceof Date ? picked.lastTs.getTime() : 0;
  if (lastTs && now - lastTs < CHANNEL_QUIET_MS) return;

  lastFiredByAgent.set(chosen.agentId, now);
  await enqueueAgentEvent(chosen.agentId, {
    trigger: "ambient",
    conversationId: picked.id,
  });
}
