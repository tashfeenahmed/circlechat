import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, lt, desc, isNull, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications, conversationMembers } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { publishToMember } from "../lib/events.js";

const ListQuery = z.object({
  // ISO timestamp cursor for pagination (return rows older than this).
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // When "1"/"true", only unread rows.
  unread: z.enum(["0", "1", "true", "false"]).optional(),
});

export default async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  // List notifications for the caller (their current-workspace member), newest
  // first, with a `before` cursor for infinite scroll. Scoped to memberId — a
  // member only ever has rows addressed to them.
  app.get("/notifications", async (req) => {
    const memberId = req.auth!.memberId!;
    const q = ListQuery.parse(req.query ?? {});
    const limit = q.limit ?? 30;
    const unreadOnly = q.unread === "1" || q.unread === "true";

    const conds = [eq(notifications.memberId, memberId)];
    if (unreadOnly) conds.push(isNull(notifications.readAt));
    if (q.before) conds.push(lt(notifications.createdAt, new Date(q.before)));

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      notifications: page,
      hasMore,
      nextBefore: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
    };
  });

  // Unread count — cheap, used to badge the bell icon.
  app.get("/notifications/unread-count", async (req) => {
    const memberId = req.auth!.memberId!;
    const [row] = await db
      .select({ c: dsql<number>`count(*)::int`.as("c") })
      .from(notifications)
      .where(and(eq(notifications.memberId, memberId), isNull(notifications.readAt)));
    return { count: Number(row?.c ?? 0) };
  });

  // Mark one notification read. Idempotent; only touches the caller's own rows.
  app.post("/notifications/:id/read", async (req, reply) => {
    const memberId = req.auth!.memberId!;
    const nid = (req.params as { id: string }).id;
    const res = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, nid),
          eq(notifications.memberId, memberId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    if (res.length === 0) {
      // Either not theirs, missing, or already read — surface a 404 only when
      // the row truly isn't the caller's, otherwise treat as a no-op success.
      const [exists] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.id, nid), eq(notifications.memberId, memberId)))
        .limit(1);
      if (!exists) return reply.code(404).send({ error: "not_found" });
    }
    await publishToMember(memberId, {
      type: "notification.read",
      memberId,
      notificationId: nid,
    });
    return { ok: true };
  });

  // Mark every unread notification that points at a given conversation read.
  // Called when the user opens that conversation, so landing on a channel/DM
  // clears its mention/DM notifications without clicking each one.
  app.post("/notifications/read-by-conversation", async (req, reply) => {
    const memberId = req.auth!.memberId!;
    const Body = z.object({ conversationId: z.string().min(1) });
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "conversationId_required" });
    const rows = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.memberId, memberId),
          eq(notifications.conversationId, parsed.data.conversationId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    // Push a read event per affected row so the bell updates live (reuses the
    // single-id read handler the client already has). Usually only a handful.
    for (const r of rows) {
      await publishToMember(memberId, {
        type: "notification.read",
        memberId,
        notificationId: r.id,
      });
    }
    return { ok: true, count: rows.length };
  });

  // Mark all the caller's notifications read.
  app.post("/notifications/read-all", async (req) => {
    const memberId = req.auth!.memberId!;
    const now = new Date();
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(and(eq(notifications.memberId, memberId), isNull(notifications.readAt)));
    // The bell (notifications table) and the left-sidebar unread badges are
    // backed by DIFFERENT sources: the sidebar counts messages newer than each
    // conversation's `last_read_at`. "Mark all read" must clear BOTH, so also
    // advance the caller's read marker across every conversation they belong to
    // — same write the per-conversation `POST /conversations/:id/read` does,
    // just unscoped. Idempotent; only touches the caller's own rows.
    await db
      .update(conversationMembers)
      .set({ lastReadAt: now })
      .where(eq(conversationMembers.memberId, memberId));
    await publishToMember(memberId, {
      type: "notification.read",
      memberId,
      notificationId: null, // null = "all"
    });
    return { ok: true };
  });
}
