import { and, desc, eq, gt, inArray, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  conversationMembers,
  conversations,
  members,
  messages,
  users,
} from "../db/schema.js";
import { enqueueAgentEvent } from "./enqueue.js";

// Extract @handles from a message body. Case-insensitive, returns lowercased
// handles. `@everyone` / `@channel` are kept in the list so callers can
// detect broadcasts.
export function extractMentionHandles(body: string): string[] {
  const out = new Set<string>();
  const re = /@([a-z0-9][a-z0-9._-]{1,39})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.add(m[1]!.toLowerCase());
  return Array.from(out);
}

// Translate a list of raw @handles (users or agents) into memberIds in the
// given workspace. @everyone / @channel are filtered out — callers handle
// broadcasts separately.
export async function resolveHandlesToMemberIds(
  handles: string[],
  workspaceId: string,
): Promise<string[]> {
  const direct = handles.filter((h) => h !== "everyone" && h !== "channel");
  if (!direct.length) return [];
  const out: string[] = [];
  for (const h of direct) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, h))
      .limit(1);
    if (u) {
      const [m] = await db
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.kind, "user"),
            eq(members.refId, u.id),
            eq(members.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (m) out.push(m.id);
      continue;
    }
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.handle, h), eq(agents.workspaceId, workspaceId)))
      .limit(1);
    if (a) {
      const [m] = await db
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.kind, "agent"),
            eq(members.refId, a.id),
            eq(members.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (m) out.push(m.id);
    }
  }
  return out;
}

const SLOT_MS = Number(process.env.BROADCAST_SLOT_MS ?? 22_000);
const JITTER_MS = Number(process.env.BROADCAST_JITTER_MS ?? 8_000);

// Fire the downstream triggers that a newly-posted message should cause:
//   • DM: wake every agent in the conversation
//   • direct @-mention: wake mentioned agents immediately
//   • @everyone / @channel in a channel: stagger-wake each agent in the
//     conversation so they don't all reply over each other
//   • thread reply: wake agents that have already participated in the thread
//
// This used to live inline in routes/messages.ts (human post path); pulling
// it out lets the agent-api post_message route (agent-authored posts) use
// the same logic — otherwise agent-to-agent @mentions never fired a trigger.
export async function fireMentionTriggers(params: {
  authorMemberId: string;
  conversationId: string;
  messageId: string;
  bodyMd: string;
  parentId: string | null;
  workspaceId: string;
  // Pre-resolved mention ids (mentioned users + agents). Callers that
  // already resolved these for the messages.mentions JSONB column can pass
  // them here; otherwise we resolve from bodyMd.
  resolvedMentionIds?: string[];
  directMentionIds?: string[];
  isBroadcast?: boolean;
}): Promise<void> {
  const {
    authorMemberId,
    conversationId,
    messageId,
    bodyMd,
    parentId,
    workspaceId,
  } = params;

  const handles = extractMentionHandles(bodyMd);
  const isBroadcast =
    params.isBroadcast ??
    handles.some((h) => h === "everyone" || h === "channel");
  const directMentionIds =
    params.directMentionIds ??
    (await resolveHandlesToMemberIds(handles, workspaceId));

  let broadcastMentionIds: string[] = [];
  if (isBroadcast) {
    const all = await db
      .select({ memberId: conversationMembers.memberId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId));
    broadcastMentionIds = all
      .map((r) => r.memberId)
      .filter((m) => m !== authorMemberId);
  }
  const resolvedMentionIds =
    params.resolvedMentionIds ??
    Array.from(new Set([...directMentionIds, ...broadcastMentionIds]));

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return;

  const firedForAgent = new Set<string>();

  // DM: every agent in the conversation (except the author) gets a DM
  // trigger. This is how an agent DM'd by a user, a user DM'd by an agent,
  // or an agent DM'd by another agent all wake up.
  if (conv.kind === "dm") {
    const agentsInConv = await db
      .select({ memberId: members.id, agentId: agents.id })
      .from(conversationMembers)
      .innerJoin(members, eq(members.id, conversationMembers.memberId))
      .innerJoin(agents, eq(agents.id, members.refId))
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(members.kind, "agent"),
        ),
      );
    for (const a of agentsInConv) {
      if (a.memberId === authorMemberId) continue;
      await enqueueAgentEvent(a.agentId, {
        trigger: "dm",
        conversationId,
        messageId,
      });
      firedForAgent.add(a.agentId);
    }
  }

  // Loop-breaker: if the author is an agent AND the mentioned agent has
  // posted in this conversation recently, skip the mention trigger. This
  // stops "thanks!"/"no thanks to YOU!" ping-pong between two agents
  // where each @ wakes the other. A user @-mentioning always fires —
  // the cooldown only applies agent→agent.
  const [authorKindRow] = await db
    .select({ kind: members.kind })
    .from(members)
    .where(eq(members.id, authorMemberId))
    .limit(1);
  const authorIsAgent = authorKindRow?.kind === "agent";
  const COOLDOWN_MS = Number(process.env.AGENT_MENTION_COOLDOWN_MS ?? 120_000);
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS);

  // Direct / broadcast mentions on a channel. Direct fires immediately;
  // broadcasts are staggered so agents see each other's replies.
  const broadcastAgents: Array<{ memberId: string; agentRefId: string }> = [];
  for (const mentionMemberId of resolvedMentionIds) {
    const [mm] = await db
      .select()
      .from(members)
      .where(eq(members.id, mentionMemberId))
      .limit(1);
    if (mm?.kind !== "agent") continue;

    // Auto-join the agent to the conversation on mention (public channels
    // and DMs). Private channels require a pre-existing invite.
    if (conv.kind !== "channel" || !conv.isPrivate) {
      await db
        .insert(conversationMembers)
        .values({
          conversationId,
          memberId: mentionMemberId,
          role: "member",
        })
        .onConflictDoNothing();
    }
    if (firedForAgent.has(mm.refId)) continue;

    // Loop-breaker: if author is an agent and the mentioned agent has
    // already posted in this conversation within COOLDOWN_MS, they've
    // just had their say — don't wake them again just because someone
    // thanked them. User-authored @-mentions still fire every time.
    if (authorIsAgent) {
      const [recent] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.memberId, mentionMemberId),
            gt(messages.ts, cooldownCutoff),
          ),
        )
        .orderBy(desc(messages.ts))
        .limit(1);
      if (recent) {
        firedForAgent.add(mm.refId);
        continue;
      }
    }

    const isDirect = directMentionIds.includes(mentionMemberId);
    if (isDirect) {
      firedForAgent.add(mm.refId);
      await enqueueAgentEvent(mm.refId, {
        trigger: "mention",
        conversationId,
        messageId,
      });
    } else {
      broadcastAgents.push({ memberId: mentionMemberId, agentRefId: mm.refId });
    }
  }
  shuffleInPlace(broadcastAgents);
  for (let i = 0; i < broadcastAgents.length; i++) {
    const { agentRefId } = broadcastAgents[i]!;
    if (firedForAgent.has(agentRefId)) continue;
    firedForAgent.add(agentRefId);
    const delayMs = i * SLOT_MS + Math.floor(Math.random() * JITTER_MS);
    setTimeout(() => {
      enqueueAgentEvent(agentRefId, {
        trigger: "mention",
        conversationId,
        messageId,
      }).catch(() => {
        // swallow — no logger plumbed through here
      });
    }, delayMs);
  }

  // Proactive read on a plain human-authored channel post (no @mention,
  // not a thread reply, not a broadcast). Factored out so routes/messages.ts
  // (the human post path that still has its own inline mention logic) can
  // call it without double-firing the mention/broadcast paths.
  const isThreadReply = !!parentId;
  const noDirectMention = directMentionIds.length === 0;
  if (conv.kind === "channel" && !isBroadcast && noDirectMention && !isThreadReply) {
    await fireChannelPostTrigger({
      conversationId,
      messageId,
      authorMemberId,
      alreadyFiredAgentIds: firedForAgent,
    });
  }

  // Thread-continuation: wake every agent that has posted in, or been
  // mentioned in, this thread previously (skipping the author and anyone
  // we've already fired above).
  if (parentId) {
    const threadMsgs = await db
      .select({ memberId: messages.memberId, mentions: messages.mentions })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          dsql`(${messages.id} = ${parentId} OR ${messages.parentId} = ${parentId})` as never,
        ),
      );
    const participating = new Set<string>();
    for (const m of threadMsgs) {
      participating.add(m.memberId);
      for (const mid of m.mentions ?? []) participating.add(mid);
    }
    participating.delete(authorMemberId);
    if (participating.size) {
      const ptMembers = await db
        .select()
        .from(members)
        .where(inArray(members.id, Array.from(participating)));
      for (const pm of ptMembers) {
        if (pm.kind !== "agent") continue;
        if (firedForAgent.has(pm.refId)) continue;
        // Same loop-breaker as direct mentions: if the author is an agent
        // and this thread participant has posted in the conversation
        // recently, skip — their last post is their voice in this thread.
        if (authorIsAgent) {
          const [recent] = await db
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, conversationId),
                eq(messages.memberId, pm.id),
                gt(messages.ts, cooldownCutoff),
              ),
            )
            .orderBy(desc(messages.ts))
            .limit(1);
          if (recent) {
            firedForAgent.add(pm.refId);
            continue;
          }
        }
        firedForAgent.add(pm.refId);
        await enqueueAgentEvent(pm.refId, {
          trigger: "thread_reply",
          conversationId,
          messageId,
        });
      }
    }
  }
}

// Stagger-wake every agent in the channel so each sees the previous one's
// reply before deciding whether to chime in. Only fires when the author is
// a human — agents replying to each other must not loop back through here.
export async function fireChannelPostTrigger(params: {
  conversationId: string;
  messageId: string;
  authorMemberId: string;
  alreadyFiredAgentIds?: Set<string>;
}): Promise<void> {
  const { conversationId, messageId, authorMemberId } = params;
  const already = params.alreadyFiredAgentIds ?? new Set<string>();

  const [authorMem] = await db
    .select({ kind: members.kind })
    .from(members)
    .where(eq(members.id, authorMemberId))
    .limit(1);
  if (authorMem?.kind !== "user") return;

  const agentMembers = await db
    .select({ memberId: members.id, agentId: agents.id })
    .from(conversationMembers)
    .innerJoin(members, eq(members.id, conversationMembers.memberId))
    .innerJoin(agents, eq(agents.id, members.refId))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(members.kind, "agent"),
      ),
    );
  const pool = agentMembers.filter((a) => !already.has(a.agentId));
  shuffleInPlace(pool);
  for (let i = 0; i < pool.length; i++) {
    const { agentId } = pool[i]!;
    already.add(agentId);
    const delayMs = i * SLOT_MS + Math.floor(Math.random() * JITTER_MS);
    setTimeout(() => {
      enqueueAgentEvent(agentId, {
        trigger: "channel_post",
        conversationId,
        messageId,
      }).catch(() => {
        // fire-and-forget
      });
    }, delayMs);
  }
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}
