import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray, desc, ilike, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  conversationMembers,
  conversations,
  messages,
  members,
  users,
  agents,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";

const QuerySchema = z.object({
  q: z.string().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/search", async (req, reply) => {
    const { memberId } = req.auth!;
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const { q, limit = 20 } = parsed.data;

    const mc = await db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.memberId, memberId));
    const convIds = mc.map((r) => r.conversationId);
    if (!convIds.length) return { matches: [] };

    // Escape LIKE wildcards in user input so `%` / `_` aren't interpreted.
    const needle = q.replace(/[%_\\]/g, (c) => `\\${c}`);
    const pattern = `%${needle}%`;

    const rows = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        memberId: messages.memberId,
        bodyMd: messages.bodyMd,
        ts: messages.ts,
        parentId: messages.parentId,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, convIds),
          ilike(messages.bodyMd, pattern),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.ts))
      .limit(limit);

    if (!rows.length) return { matches: [] };

    const uniqueConvIds = Array.from(new Set(rows.map((r) => r.conversationId)));
    const convRows = await db
      .select({
        id: conversations.id,
        kind: conversations.kind,
        name: conversations.name,
      })
      .from(conversations)
      .where(inArray(conversations.id, uniqueConvIds));
    const convById = new Map(convRows.map((c) => [c.id, c]));

    const dmConvIds = convRows.filter((c) => c.kind === "dm").map((c) => c.id);
    const dmOtherByConv = new Map<string, string>();
    if (dmConvIds.length) {
      const dmRows = await db
        .select({
          conversationId: conversationMembers.conversationId,
          memberId: conversationMembers.memberId,
        })
        .from(conversationMembers)
        .where(inArray(conversationMembers.conversationId, dmConvIds));
      for (const cid of dmConvIds) {
        const these = dmRows.filter((r) => r.conversationId === cid);
        const other = these.find((r) => r.memberId !== memberId)?.memberId ?? memberId;
        dmOtherByConv.set(cid, other);
      }
    }

    const authorIds = Array.from(new Set(rows.map((r) => r.memberId)));
    const dirRows = await db
      .select({ id: members.id, kind: members.kind, refId: members.refId })
      .from(members)
      .where(inArray(members.id, authorIds));
    const userRefs = dirRows.filter((d) => d.kind === "user").map((d) => d.refId);
    const agentRefs = dirRows.filter((d) => d.kind === "agent").map((d) => d.refId);
    const userRows = userRefs.length
      ? await db
          .select({
            id: users.id,
            name: users.name,
            handle: users.handle,
            avatarColor: users.avatarColor,
          })
          .from(users)
          .where(inArray(users.id, userRefs))
      : [];
    const agentRows = agentRefs.length
      ? await db
          .select({
            id: agents.id,
            name: agents.name,
            handle: agents.handle,
            avatarColor: agents.avatarColor,
          })
          .from(agents)
          .where(inArray(agents.id, agentRefs))
      : [];
    const byUserId = new Map(userRows.map((u) => [u.id, u]));
    const byAgentId = new Map(agentRows.map((a) => [a.id, a]));
    const authorByMember = new Map(
      dirRows.map((d) => {
        if (d.kind === "user") {
          const u = byUserId.get(d.refId);
          return [
            d.id,
            u
              ? { kind: "user" as const, name: u.name, handle: u.handle, avatarColor: u.avatarColor }
              : null,
          ];
        }
        const a = byAgentId.get(d.refId);
        return [
          d.id,
          a
            ? { kind: "agent" as const, name: a.name, handle: a.handle, avatarColor: a.avatarColor }
            : null,
        ];
      }),
    );

    return {
      matches: rows.map((r) => {
        const c = convById.get(r.conversationId) ?? null;
        const otherMemberId =
          c?.kind === "dm" ? dmOtherByConv.get(r.conversationId) ?? memberId : undefined;
        return {
          id: r.id,
          conversationId: r.conversationId,
          parentId: r.parentId,
          bodyMd: r.bodyMd,
          ts: r.ts,
          conversation: c
            ? { id: c.id, kind: c.kind, name: c.name, otherMemberId }
            : null,
          author: authorByMember.get(r.memberId) ?? null,
        };
      }),
    };
  });
}
