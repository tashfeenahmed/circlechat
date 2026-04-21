import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray, desc, sql as dsql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import {
  conversations,
  conversationMembers,
  members,
  users,
  agents,
  messages,
  reactions,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { id } from "../lib/ids.js";

function dmId(a: string, b: string): string {
  const sorted = [a, b].sort().join(":");
  return `c_dm_${createHash("sha1").update(sorted).digest("hex").slice(0, 24)}`;
}

const CreateBody = z.object({
  kind: z.enum(["channel", "dm"]),
  name: z.string().min(1).max(100).optional(),
  topic: z.string().max(500).optional(),
  isPrivate: z.boolean().optional(),
  memberIds: z.array(z.string()).optional(),
});

const AddMembersBody = z.object({ memberIds: z.array(z.string()).min(1) });

const UpdateBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    topic: z.string().max(500).optional(),
  })
  .refine((v) => v.name !== undefined || v.topic !== undefined, {
    message: "nothing_to_update",
  });

export default async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/conversations", async (req) => {
    const { memberId } = req.auth!;
    const rows = await db
      .select({
        id: conversations.id,
        kind: conversations.kind,
        name: conversations.name,
        topic: conversations.topic,
        isPrivate: conversations.isPrivate,
        archived: conversations.archived,
        createdAt: conversations.createdAt,
        role: conversationMembers.role,
        lastReadAt: conversationMembers.lastReadAt,
        muted: conversationMembers.muted,
      })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(eq(conversationMembers.memberId, memberId));

    // Attach members list + last message timestamp per conversation.
    const convIds = rows.map((r) => r.id);
    const allMembers = convIds.length
      ? await db
          .select({
            conversationId: conversationMembers.conversationId,
            memberId: conversationMembers.memberId,
          })
          .from(conversationMembers)
          .where(inArray(conversationMembers.conversationId, convIds))
      : [];

    const lastTs = convIds.length
      ? await db
          .select({
            conversationId: messages.conversationId,
            ts: dsql<Date>`max(${messages.ts})`.as("ts"),
          })
          .from(messages)
          .where(inArray(messages.conversationId, convIds))
          .groupBy(messages.conversationId)
      : [];
    const lastTsMap = new Map(lastTs.map((r) => [r.conversationId, r.ts]));

    // Per-conversation unread counts: messages newer than lastReadAt and not
    // authored by the caller. Mention count is a subset (caller's memberId is
    // in `mentions`).
    const unreadRows = convIds.length
      ? await db
          .select({
            conversationId: messages.conversationId,
            total: dsql<number>`count(*)::int`.as("total"),
            mentioned: dsql<number>`sum(case when ${messages.mentions} ? ${memberId} then 1 else 0 end)::int`.as(
              "mentioned",
            ),
          })
          .from(messages)
          .innerJoin(
            conversationMembers,
            and(
              eq(conversationMembers.conversationId, messages.conversationId),
              eq(conversationMembers.memberId, memberId),
            ),
          )
          .where(
            and(
              inArray(messages.conversationId, convIds),
              dsql`${messages.memberId} <> ${memberId}` as never,
              dsql`${messages.ts} > coalesce(${conversationMembers.lastReadAt}, 'epoch'::timestamptz)` as never,
              dsql`${messages.deletedAt} is null` as never,
            ),
          )
          .groupBy(messages.conversationId)
      : [];
    const unreadMap = new Map(
      unreadRows.map((r) => [r.conversationId, { unread: Number(r.total) || 0, mentions: Number(r.mentioned) || 0 }]),
    );

    const byConv = new Map<string, string[]>();
    for (const m of allMembers) {
      const arr = byConv.get(m.conversationId) ?? [];
      arr.push(m.memberId);
      byConv.set(m.conversationId, arr);
    }

    return {
      conversations: rows.map((r) => ({
        ...r,
        memberIds: byConv.get(r.id) ?? [],
        lastMessageAt: lastTsMap.get(r.id) ?? null,
        unreadCount: unreadMap.get(r.id)?.unread ?? 0,
        unreadMentions: unreadMap.get(r.id)?.mentions ?? 0,
      })),
    };
  });

  app.post("/conversations", async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const { memberId } = req.auth!;

    const { workspaceId } = req.auth!;

    if (body.kind === "channel") {
      if (!body.name) return reply.code(400).send({ error: "name_required" });
      const convId = id("c");
      await db.insert(conversations).values({
        id: convId,
        workspaceId: workspaceId!,
        kind: "channel",
        name: body.name,
        topic: body.topic ?? "",
        isPrivate: body.isPrivate ?? false,
        createdBy: memberId,
      });
      const extra = (body.memberIds ?? []).filter((m) => m !== memberId);
      await db.insert(conversationMembers).values([
        { conversationId: convId, memberId: memberId!, role: "admin" },
        ...extra.map((m) => ({ conversationId: convId, memberId: m, role: "member" as const })),
      ]);
      // Auto-join every member of THIS workspace to public channels.
      if (!(body.isPrivate ?? false)) {
        const wsMembers = await db
          .select({ id: members.id })
          .from(members)
          .where(eq(members.workspaceId, workspaceId!));
        const toAdd = wsMembers
          .map((m) => m.id)
          .filter((m) => m !== memberId && !extra.includes(m));
        if (toAdd.length) {
          await db.insert(conversationMembers).values(
            toAdd.map((m) => ({ conversationId: convId, memberId: m, role: "member" as const })),
          );
        }
      }
      return { id: convId };
    }

    // DM: self-DM (notes) when no other, otherwise exactly one other member —
    // and the other member MUST belong to the same workspace.
    if (body.kind === "dm") {
      const others = (body.memberIds ?? []).filter((m) => m !== memberId);
      if (others.length > 1) return reply.code(400).send({ error: "dm_needs_one_other" });
      const other = others[0] ?? memberId!;
      const selfDm = other === memberId;

      if (!selfDm) {
        const [om] = await db
          .select({ id: members.id })
          .from(members)
          .where(
            and(eq(members.id, other), eq(members.workspaceId, workspaceId!)),
          )
          .limit(1);
        if (!om) return reply.code(403).send({ error: "other_not_in_workspace" });
      }

      const convId = dmId(memberId!, other);
      await db
        .insert(conversations)
        .values({
          id: convId,
          workspaceId: workspaceId!,
          kind: "dm",
          createdBy: memberId,
        })
        .onConflictDoNothing();
      await db
        .insert(conversationMembers)
        .values(
          selfDm
            ? [{ conversationId: convId, memberId: memberId!, role: "member" }]
            : [
                { conversationId: convId, memberId: memberId!, role: "member" },
                { conversationId: convId, memberId: other, role: "member" },
              ],
        )
        .onConflictDoNothing();
      return { id: convId };
    }
  });

  app.get("/conversations/:id", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const { memberId } = req.auth!;
    const [membership] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      )
      .limit(1);
    if (!membership) return reply.code(403).send({ error: "not_a_member" });

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
    if (!conv) return reply.code(404).send({ error: "not_found" });

    const mem = await db
      .select({ memberId: conversationMembers.memberId, role: conversationMembers.role })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, convId));

    return { conversation: conv, members: mem };
  });

  app.post("/conversations/:id/members", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const body = AddMembersBody.parse(req.body);
    const { memberId } = req.auth!;

    const [membership] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      )
      .limit(1);
    if (!membership) return reply.code(403).send({ error: "not_a_member" });

    for (const mid of body.memberIds) {
      await db
        .insert(conversationMembers)
        .values({ conversationId: convId, memberId: mid, role: "member" })
        .onConflictDoNothing();
    }
    return { ok: true };
  });

  app.post("/conversations/:id/read", async (req) => {
    const convId = (req.params as { id: string }).id;
    const { memberId } = req.auth!;
    await db
      .update(conversationMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      );
    return { ok: true };
  });

  app.post("/conversations/:id/archive", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const { memberId } = req.auth!;
    const [m] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      );
    if (!m || m.role !== "admin") return reply.code(403).send({ error: "not_admin" });
    await db.update(conversations).set({ archived: true }).where(eq(conversations.id, convId));
    return { ok: true };
  });

  // Admin-only rename / retopic. DMs are name-less — reject those so the UI
  // can't accidentally expose a rename control on a DM row.
  app.patch("/conversations/:id", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const body = UpdateBody.parse(req.body);
    const { memberId } = req.auth!;
    const [mem] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      )
      .limit(1);
    if (!mem || mem.role !== "admin") return reply.code(403).send({ error: "not_admin" });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    if (conv.kind !== "channel") return reply.code(400).send({ error: "not_a_channel" });

    const patch: Partial<typeof conversations.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.topic !== undefined) patch.topic = body.topic;
    await db.update(conversations).set(patch).where(eq(conversations.id, convId));
    return { ok: true, conversation: { ...conv, ...patch } };
  });

  // Admin-only hard delete. Drops all messages, reactions, and memberships.
  // "Archive" stays as the soft path; delete is for cleanup after demo/test
  // channels. Only channels — DMs can't be deleted this way.
  app.delete("/conversations/:id", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const { memberId } = req.auth!;
    const [mem] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      )
      .limit(1);
    if (!mem || mem.role !== "admin") return reply.code(403).send({ error: "not_admin" });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    if (conv.kind !== "channel") return reply.code(400).send({ error: "not_a_channel" });

    // Child rows before the parent: reactions (only through their messages),
    // messages, conversation_members, then the conversation itself.
    const msgIds = (
      await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, convId))
    ).map((r) => r.id);
    if (msgIds.length) {
      await db.delete(reactions).where(inArray(reactions.messageId, msgIds));
      await db.delete(messages).where(eq(messages.conversationId, convId));
    }
    await db.delete(conversationMembers).where(eq(conversationMembers.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    return { ok: true };
  });

  // Admin-only member removal. Kicks a member out of a channel; they lose
  // the ability to see it and stop receiving events for it. Admins can't
  // remove themselves this way (that's a self-leave, not implemented).
  app.delete("/conversations/:id/members/:memberId", async (req, reply) => {
    const convId = (req.params as { id: string }).id;
    const target = (req.params as { memberId: string }).memberId;
    const { memberId } = req.auth!;
    if (target === memberId) return reply.code(400).send({ error: "cannot_remove_self" });
    const [mem] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, memberId),
        ),
      )
      .limit(1);
    if (!mem || mem.role !== "admin") return reply.code(403).send({ error: "not_admin" });
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, convId),
          eq(conversationMembers.memberId, target),
        ),
      );
    return { ok: true };
  });

  app.get("/members", async (req) => {
    // Combined directory: humans + agents of the CURRENT workspace only.
    const { workspaceId } = req.auth!;
    const u = await db
      .select({
        memberId: members.id,
        id: users.id,
        kind: dsql<"user">`'user'`.as("kind"),
        name: users.name,
        handle: users.handle,
        avatarColor: users.avatarColor,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.refId))
      .where(and(eq(members.kind, "user"), eq(members.workspaceId, workspaceId!)))
      .orderBy(desc(users.createdAt));

    const a = await db
      .select({
        memberId: members.id,
        id: agents.id,
        kind: dsql<"agent">`'agent'`.as("kind"),
        name: agents.name,
        handle: agents.handle,
        avatarColor: agents.avatarColor,
        agentKind: agents.kind,
        status: agents.status,
        title: agents.title,
        brief: agents.brief,
        createdAt: agents.createdAt,
      })
      .from(members)
      .innerJoin(agents, eq(agents.id, members.refId))
      .where(and(eq(members.kind, "agent"), eq(members.workspaceId, workspaceId!)))
      .orderBy(desc(agents.createdAt));

    return { humans: u, agents: a };
  });
}
