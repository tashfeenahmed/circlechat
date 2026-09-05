import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, asc, desc, lt, isNull, inArray, or, sql as dsql } from "drizzle-orm";
void asc;
void or;
import { db } from "../db/index.js";
import {
  conversations,
  conversationMembers,
  messages,
  reactions,
  agents,
  members,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { id } from "../lib/ids.js";
import { publishToConversation } from "../lib/events.js";
import { enqueueAgentEvent } from "../agents/enqueue.js";
import { fireChannelPostTrigger, resolveHandlesToMemberIds } from "../agents/mention-triggers.js";
import { notifyForMessage } from "../lib/notifications.js";
import { sanitizeAttachments } from "../agents/executor.js";

// Query-string helpers: `Number("abc")` is NaN and `new Date("garbage")` is an
// Invalid Date — both used to flow straight into the SQL builder and 500.
function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}
function parseBefore(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const PostBody = z.object({
  bodyMd: z.string().min(1).max(20_000),
  parentId: z.string().optional().nullable(),
  attachments: z
    .array(
      z.object({
        key: z.string(),
        name: z.string(),
        contentType: z.string(),
        size: z.number(),
        url: z.string(),
      }),
    )
    .optional(),
});

const EditBody = z.object({ bodyMd: z.string().min(1).max(20_000) });
const ReactBody = z.object({ emoji: z.string().min(1).max(32) });

export default async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/conversations/:id/messages", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const q = req.query as { parent_id?: string; before?: string; limit?: string };
    const memberId = req.auth!.memberId!;

    const [mm] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      );
    if (!mm) return reply.code(403).send({ error: "not_a_member" });

    const limit = parseLimit(q.limit, 50, 200);
    const where = [eq(messages.conversationId, convId)];
    if (q.parent_id) where.push(eq(messages.parentId, q.parent_id));
    else where.push(isNull(messages.parentId));
    // `before` is a keyset cursor (the ts of the oldest message the client
    // already holds). Without it we want the NEWEST page, not the oldest — so
    // we always fetch in descending order and reverse for display. The old
    // `asc + limit` returned the first 200 messages ever sent, which meant a
    // busy channel never showed recent activity.
    const before = parseBefore(q.before);
    if (q.before && !before) return reply.code(400).send({ error: "invalid_before" });
    if (before) where.push(lt(messages.ts, before));

    const rows = await db
      .select()
      .from(messages)
      .where(and(...where))
      .orderBy(desc(messages.ts))
      .limit(limit);
    // A full page back implies there may be older messages still to load.
    const hasMore = rows.length === limit;
    rows.reverse(); // oldest → newest for rendering

    const ids = rows.map((r) => r.id);
    const rx = ids.length
      ? await db.select().from(reactions).where(inArray(reactions.messageId, ids))
      : [];

    const tc = ids.length
      ? await db
          .select({
            parentId: messages.parentId,
            ct: dsql<number>`count(*)::int`.as("ct"),
          })
          .from(messages)
          .where(inArray(messages.parentId, ids))
          .groupBy(messages.parentId)
      : [];

    const tcMap = new Map(tc.map((t) => [t.parentId ?? "", Number(t.ct)]));
    const rxMap = new Map<string, Array<{ emoji: string; memberId: string }>>();
    for (const r of rx) {
      const list = rxMap.get(r.messageId) ?? [];
      list.push({ emoji: r.emoji, memberId: r.memberId });
      rxMap.set(r.messageId, list);
    }

    return {
      messages: rows.map((m) => ({
        ...m,
        reactions: rxMap.get(m.id) ?? [],
        replyCount: tcMap.get(m.id) ?? 0,
      })),
      hasMore,
    };
  });

  app.post("/conversations/:id/messages", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const body = PostBody.parse(req.body);
    const memberId = req.auth!.memberId!;

    const [mm] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      );
    if (!mm) return reply.code(403).send({ error: "not_a_member" });

    // A thread reply must hang off a top-level message in THIS conversation.
    // Otherwise a client could parent a message onto any message id (another
    // conversation, or a reply) and the thread-continuation logic below would
    // wake agents / count replies against the wrong root.
    if (body.parentId) {
      const [parent] = await db
        .select({ conversationId: messages.conversationId, parentId: messages.parentId })
        .from(messages)
        .where(eq(messages.id, body.parentId))
        .limit(1);
      if (!parent || parent.conversationId !== convId) {
        return reply.code(400).send({ error: "invalid_parent" });
      }
      if (parent.parentId) body.parentId = parent.parentId; // replies to a reply flatten onto the root
    }

    // Attachment descriptors are client-supplied. Restrict them to keys the
    // server itself wrote (u/<rand>/<name>) exactly as the agent path does, so
    // a hand-rolled descriptor can't point chat at an arbitrary URL or key.
    const attachments = sanitizeAttachments(body.attachments);

    const mentions = extractMentions(body.bodyMd);
    // Resolve @handles to member ids IN THIS WORKSPACE. The old resolver picked
    // an arbitrary member row for the user, so someone in two workspaces got
    // their mention (and notification) routed to the wrong workspace's member.
    const directMentionIds = await resolveHandlesToMemberIds(mentions, req.auth!.workspaceId!);
    const isBroadcast = mentions.some((h) => h === "everyone" || h === "channel");
    const broadcastMentionIds = new Set<string>();
    if (isBroadcast) {
      const all = await db
        .select({ memberId: conversationMembers.memberId })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, convId));
      for (const r of all) if (r.memberId !== memberId) broadcastMentionIds.add(r.memberId);
    }
    const resolvedMentionIds = Array.from(
      new Set([...directMentionIds, ...broadcastMentionIds]),
    );

    const msgId = id("m");
    const now = new Date();
    await db.insert(messages).values({
      id: msgId,
      conversationId: convId,
      memberId,
      parentId: body.parentId ?? null,
      bodyMd: body.bodyMd,
      attachmentsJson: attachments,
      mentions: resolvedMentionIds,
      ts: now,
    });

    const payload = {
      id: msgId,
      conversationId: convId,
      memberId,
      parentId: body.parentId ?? null,
      bodyMd: body.bodyMd,
      attachmentsJson: attachments,
      mentions: resolvedMentionIds,
      ts: now.toISOString(),
      reactions: [],
      replyCount: 0,
    };

    await publishToConversation(convId, {
      type: "message.new",
      conversationId: convId,
      message: payload,
    });

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
    if (conv) {
      // Inbox notifications for human recipients (DM + direct mentions). Agents
      // are woken by the trigger logic below, not the inbox. Fire-and-forget.
      notifyForMessage({
        workspaceId: req.auth!.workspaceId!,
        conversationId: convId,
        messageId: msgId,
        authorMemberId: memberId,
        bodyMd: body.bodyMd,
        directMentionIds,
        isDm: conv.kind === "dm",
      }).catch((e) => req.log.warn({ err: (e as Error).message }, "notifyForMessage"));
      if (conv.kind === "dm") {
        const agentsInConv = await db
          .select({ memberId: members.id, agentId: agents.id })
          .from(conversationMembers)
          .innerJoin(members, eq(members.id, conversationMembers.memberId))
          .innerJoin(agents, eq(agents.id, members.refId))
          .where(
            and(eq(conversationMembers.conversationId, convId), eq(members.kind, "agent")),
          );
        for (const a of agentsInConv) {
          if (a.memberId === memberId) continue;
          await enqueueAgentEvent(a.agentId, {
            trigger: "dm",
            conversationId: convId,
            messageId: msgId,
          });
        }
      }
      const firedForAgent = new Set<string>();
      // First pass: do side-effects (auto-join, firedForAgent) and split into
      // direct-fires vs broadcast-fires so we can stagger the broadcasts.
      const broadcastAgents: Array<{ memberId: string; agentRefId: string }> = [];
      for (const mentionMemberId of resolvedMentionIds) {
        const [mm2] = await db.select().from(members).where(eq(members.id, mentionMemberId)).limit(1);
        if (mm2?.kind !== "agent") continue;
        // Auto-join a mentioned agent ONLY in a public channel. DMs and
        // private channels have fixed membership — mentioning a non-participant
        // there must not pull them in (DMs are private to their participants).
        if (conv.kind === "channel" && !conv.isPrivate) {
          await db
            .insert(conversationMembers)
            .values({ conversationId: convId, memberId: mentionMemberId, role: "member" })
            .onConflictDoNothing();
        }
        // Never trigger an agent that isn't a member of this conversation. In
        // a public channel the auto-join above guarantees membership; in a DM
        // or private channel this gates out @mentions of agents who don't
        // belong, so an agent can't be tagged into a private DM it can't see.
        const [mentionIsMember] = await db
          .select({ id: conversationMembers.memberId })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, convId),
              eq(conversationMembers.memberId, mentionMemberId),
            ),
          )
          .limit(1);
        if (!mentionIsMember) continue;
        firedForAgent.add(mm2.refId);

        const isDirect = directMentionIds.includes(mentionMemberId);
        if (isDirect) {
          // Direct @-mentions fire immediately.
          await enqueueAgentEvent(mm2.refId, {
            trigger: "mention",
            conversationId: convId,
            messageId: msgId,
          });
        } else {
          broadcastAgents.push({ memberId: mentionMemberId, agentRefId: mm2.refId });
        }
      }

      // Broadcast (@everyone / @channel): shuffle and assign position-based
      // slots so each agent fires well AFTER the previous agent has had time
      // to post its reply. Without this, two agents sampled 2s and 4s from a
      // narrow window both start before either has replied, so neither sees
      // the other's message.
      //
      // Slot width > typical Hermes reply latency (~15–20s). Within a slot
      // we still jitter so the exact firing time isn't predictable and two
      // runs of @everyone don't produce the same ordering.
      const SLOT_MS = 22_000;
      const JITTER_MS = 8_000;
      shuffleInPlace(broadcastAgents);
      for (let i = 0; i < broadcastAgents.length; i++) {
        const { agentRefId } = broadcastAgents[i]!;
        const delayMs = i * SLOT_MS + Math.floor(Math.random() * JITTER_MS);
        setTimeout(() => {
          enqueueAgentEvent(agentRefId, {
            trigger: "mention",
            conversationId: convId,
            messageId: msgId,
          }).catch((e) => req.log.warn({ err: (e as Error).message }, "broadcast enqueue"));
        }, delayMs);
      }

      // Proactive read-and-decide on a plain channel post (no @, no
      // broadcast, not in a thread). Every agent member gets a
      // channel_post trigger, stagger-fired so they see each other's
      // replies. The agent prompt tells them to default to silence unless
      // they can add something useful.
      if (
        conv.kind === "channel" &&
        directMentionIds.length === 0 &&
        !isBroadcast &&
        !body.parentId
      ) {
        await fireChannelPostTrigger({
          conversationId: convId,
          messageId: msgId,
          authorMemberId: memberId,
          alreadyFiredAgentIds: firedForAgent,
        });
      }

      // Thread-continuation: if this message is inside a thread, wake any agent
      // who's already participated in the thread (posted OR been mentioned in
      // any thread message) — excluding the author and anyone we already fired
      // a mention trigger for above.
      if (body.parentId) {
        const rootId = body.parentId;
        const threadMsgs = await db
          .select({ memberId: messages.memberId, mentions: messages.mentions })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, convId),
              // the root + every reply of this thread
              dsql`(${messages.id} = ${rootId} OR ${messages.parentId} = ${rootId})` as never,
            ),
          );
        const participatingMemberIds = new Set<string>();
        for (const m of threadMsgs) {
          participatingMemberIds.add(m.memberId);
          for (const mid of m.mentions ?? []) participatingMemberIds.add(mid);
        }
        participatingMemberIds.delete(memberId);
        if (participatingMemberIds.size) {
          // Only wake thread participants who are actually members of this
          // conversation — a recorded @mention of a non-member (e.g. an agent
          // tagged in a private DM) must not pull them in via the thread path.
          const convMemberRows = await db
            .select({ memberId: conversationMembers.memberId })
            .from(conversationMembers)
            .where(eq(conversationMembers.conversationId, convId));
          const convMemberSet = new Set(convMemberRows.map((r) => r.memberId));
          const participatingMembers = await db
            .select()
            .from(members)
            .where(inArray(members.id, Array.from(participatingMemberIds)));
          for (const pm of participatingMembers) {
            if (pm.kind !== "agent") continue;
            if (!convMemberSet.has(pm.id)) continue;
            if (firedForAgent.has(pm.refId)) continue;
            await enqueueAgentEvent(pm.refId, {
              trigger: "thread_reply",
              conversationId: convId,
              messageId: msgId,
            });
          }
        }
      }
    }

    return { message: payload };
  });

  app.patch("/messages/:id", async (req, reply) => {
    const mId = (req.params as { id: string }).id;
    const body = EditBody.parse(req.body);
    const memberId = req.auth!.memberId!;
    const [m] = await db.select().from(messages).where(eq(messages.id, mId)).limit(1);
    if (!m) return reply.code(404).send({ error: "not_found" });
    if (m.memberId !== memberId) return reply.code(403).send({ error: "not_author" });
    const editedAt = new Date();
    await db.update(messages).set({ bodyMd: body.bodyMd, editedAt }).where(eq(messages.id, mId));
    await publishToConversation(m.conversationId, {
      type: "message.edited",
      conversationId: m.conversationId,
      messageId: mId,
      bodyMd: body.bodyMd,
      editedAt: editedAt.toISOString(),
    });
    return { ok: true };
  });

  app.delete("/messages/:id", async (req, reply) => {
    const mId = (req.params as { id: string }).id;
    const memberId = req.auth!.memberId!;
    const [m] = await db.select().from(messages).where(eq(messages.id, mId)).limit(1);
    if (!m) return reply.code(404).send({ error: "not_found" });
    if (m.memberId !== memberId) return reply.code(403).send({ error: "not_author" });
    await db.update(messages).set({ deletedAt: new Date(), bodyMd: "" }).where(eq(messages.id, mId));
    await publishToConversation(m.conversationId, {
      type: "message.deleted",
      conversationId: m.conversationId,
      messageId: mId,
    });
    return { ok: true };
  });

  app.post("/messages/:id/reactions", async (req, reply) => {
    const mId = (req.params as { id: string }).id;
    const body = ReactBody.parse(req.body);
    const memberId = req.auth!.memberId!;
    const [m] = await db.select().from(messages).where(eq(messages.id, mId)).limit(1);
    if (!m) return reply.code(404).send({ error: "not_found" });
    // Only conversation members may react — any authenticated member used to
    // be able to toggle reactions on any message by id (and the event was
    // broadcast into that conversation).
    const [inConv] = await db
      .select({ memberId: conversationMembers.memberId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, m.conversationId),
          eq(conversationMembers.memberId, memberId),
        ),
      )
      .limit(1);
    if (!inConv) return reply.code(403).send({ error: "not_a_member" });

    const [exist] = await db
      .select()
      .from(reactions)
      .where(
        and(
          eq(reactions.messageId, mId),
          eq(reactions.memberId, memberId),
          eq(reactions.emoji, body.emoji),
        ),
      )
      .limit(1);
    let added: boolean;
    if (exist) {
      await db
        .delete(reactions)
        .where(
          and(
            eq(reactions.messageId, mId),
            eq(reactions.memberId, memberId),
            eq(reactions.emoji, body.emoji),
          ),
        );
      added = false;
    } else {
      await db.insert(reactions).values({ messageId: mId, memberId, emoji: body.emoji });
      added = true;
    }

    await publishToConversation(m.conversationId, {
      type: "reaction.toggled",
      conversationId: m.conversationId,
      messageId: mId,
      memberId,
      emoji: body.emoji,
      added,
    });
    return { ok: true, added };
  });

  app.post("/conversations/:id/typing", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const memberId = req.auth!.memberId!;
    const [mm] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      );
    if (!mm) return reply.code(403).send({ error: "not_a_member" });
    await publishToConversation(convId, { type: "typing", conversationId: convId, memberId });
    return { ok: true };
  });
}

function extractMentions(body: string): string[] {
  const out = new Set<string>();
  const re = /@([a-z0-9][a-z0-9._-]{1,39})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.add(m[1].toLowerCase());
  return Array.from(out);
}

// Fisher–Yates shuffle. Used so @everyone doesn't always wake agents in the
// same (DB insertion) order — whoever happens to land in slot 0 first gets
// to set the tone of the discussion.
function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}
