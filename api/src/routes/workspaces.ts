import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, ne, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  workspaces,
  workspaceMembers,
  sessions,
  conversations,
  conversationMembers,
  members,
  messages,
  reactions,
  tasks,
  taskAssignees,
  agents,
} from "../db/schema.js";
import { requireAuth, ensureUserMember, COOKIE_NAME } from "../auth/session.js";
import { id } from "../lib/ids.js";
import { deriveUniqueWorkspaceHandle } from "../lib/workspace-handle.js";

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  mission: z.string().max(2000).optional(),
});

const PatchBody = z.object({
  mission: z.string().max(2000).optional(),
});

export default async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // List workspaces the caller belongs to.
  app.get("/workspaces", async (req) => {
    const { user, workspaceId } = req.auth!;
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        handle: workspaces.handle,
        mission: workspaces.mission,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id));
    return { workspaces: rows, currentWorkspaceId: workspaceId };
  });

  // Update workspace settings — admin only. Currently just `mission`, the
  // shared "what we build" prose every agent in this workspace inherits.
  app.patch("/workspaces/:id", async (req, reply) => {
    const targetId = (req.params as { id: string }).id;
    const { user } = req.auth!;
    const body = PatchBody.parse(req.body);

    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.workspaceId, targetId)),
      )
      .limit(1);
    if (!wm) return reply.code(403).send({ error: "not_a_member" });
    if (wm.role !== "admin") return reply.code(403).send({ error: "admin_only" });

    const patch: Record<string, unknown> = {};
    if (body.mission !== undefined) patch.mission = body.mission;
    if (Object.keys(patch).length === 0) return { ok: true, unchanged: true };

    await db.update(workspaces).set(patch).where(eq(workspaces.id, targetId));
    const [updated] = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        handle: workspaces.handle,
        mission: workspaces.mission,
      })
      .from(workspaces)
      .where(eq(workspaces.id, targetId))
      .limit(1);
    return { ok: true, workspace: updated };
  });

  // Create a new workspace and switch into it.
  app.post("/workspaces", async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const { user } = req.auth!;
    const sid = req.cookies[COOKIE_NAME];
    if (!sid) return reply.code(401).send({ error: "unauthenticated" });

    const handle = await deriveUniqueWorkspaceHandle(body.name);

    const wsId = id("w");
    await db.insert(workspaces).values({
      id: wsId,
      name: body.name,
      handle,
      createdBy: user.id,
      mission: body.mission ?? "",
    });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: wsId, userId: user.id, role: "admin" });

    const memberId = await ensureUserMember(wsId, user.id);

    // Bootstrap #general in the new workspace.
    const convId = id("c");
    await db.insert(conversations).values({
      id: convId,
      workspaceId: wsId,
      kind: "channel",
      name: "general",
      topic: "Everything and the kitchen sink.",
      createdBy: memberId,
    });
    await db
      .insert(conversationMembers)
      .values({ conversationId: convId, memberId, role: "admin" });

    await db.update(sessions).set({ currentWorkspaceId: wsId }).where(eq(sessions.id, sid));

    return {
      ok: true,
      workspace: { id: wsId, name: body.name, handle, role: "admin" },
      memberId,
    };
  });

  // Switch the session's current workspace — only if the caller belongs to it.
  app.post("/workspaces/:id/switch", async (req, reply) => {
    const targetId = (req.params as { id: string }).id;
    const { user } = req.auth!;
    const sid = req.cookies[COOKIE_NAME];
    if (!sid) return reply.code(401).send({ error: "unauthenticated" });

    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.workspaceId, targetId),
        ),
      )
      .limit(1);
    if (!wm) return reply.code(403).send({ error: "not_a_member" });

    await db.update(sessions).set({ currentWorkspaceId: targetId }).where(eq(sessions.id, sid));
    const memberId = await ensureUserMember(targetId, user.id);
    return { ok: true, workspaceId: targetId, memberId };
  });

  // ─────────── member management (admin-only) ───────────

  // List human members of the current workspace with their role — backs an
  // admin "Members" management panel. Agents are excluded (they have no role).
  app.get("/workspaces/:id/members", async (req, reply) => {
    const targetId = (req.params as { id: string }).id;
    const { user } = req.auth!;
    const me = await loadWorkspaceRole(targetId, user.id);
    if (!me) return reply.code(403).send({ error: "not_a_member" });

    const rows = await db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, targetId));
    return { members: rows, myRole: me.role };
  });

  // Change a member's workspace role (admin ↔ member). Admin-only. Guards
  // against demoting the last admin, which would orphan the workspace.
  app.patch("/workspaces/:id/members/:userId", async (req, reply) => {
    const targetWs = (req.params as { id: string }).id;
    const targetUser = (req.params as { userId: string }).userId;
    const { user } = req.auth!;
    const body = z.object({ role: z.enum(["admin", "member"]) }).parse(req.body);

    const me = await loadWorkspaceRole(targetWs, user.id);
    if (!me || me.role !== "admin") return reply.code(403).send({ error: "admin_only" });

    const [target] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, targetWs), eq(workspaceMembers.userId, targetUser)),
      )
      .limit(1);
    if (!target) return reply.code(404).send({ error: "member_not_found" });

    // Demoting an admin → block if they're the last one.
    if (target.role === "admin" && body.role !== "admin") {
      if (await isLastAdmin(targetWs, targetUser)) {
        return reply.code(400).send({ error: "last_admin" });
      }
    }

    await db
      .update(workspaceMembers)
      .set({ role: body.role })
      .where(
        and(eq(workspaceMembers.workspaceId, targetWs), eq(workspaceMembers.userId, targetUser)),
      );
    return { ok: true, role: body.role };
  });

  // Remove a human member from the workspace. Admin-only (or self-leave). Tears
  // down their member identity: conversation memberships, task assignments,
  // reassigns org reports that pointed at them to null, deletes the member row
  // and the workspace_members link. Their authored messages/comments are left
  // in place (deleting them would gut conversation history) but they lose all
  // access. Cannot remove the last admin.
  app.delete("/workspaces/:id/members/:userId", async (req, reply) => {
    const targetWs = (req.params as { id: string }).id;
    const targetUser = (req.params as { userId: string }).userId;
    const { user } = req.auth!;

    const me = await loadWorkspaceRole(targetWs, user.id);
    if (!me) return reply.code(403).send({ error: "not_a_member" });
    const isSelfLeave = targetUser === user.id;
    if (!isSelfLeave && me.role !== "admin") {
      return reply.code(403).send({ error: "admin_only" });
    }

    const [target] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, targetWs), eq(workspaceMembers.userId, targetUser)),
      )
      .limit(1);
    if (!target) return reply.code(404).send({ error: "member_not_found" });
    if (target.role === "admin" && (await isLastAdmin(targetWs, targetUser))) {
      return reply.code(400).send({ error: "last_admin" });
    }

    // Resolve their member id(s) in this workspace (a user has exactly one).
    const mRows = await db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.workspaceId, targetWs),
          eq(members.kind, "user"),
          eq(members.refId, targetUser),
        ),
      );
    const memberIds = mRows.map((r) => r.id);

    await db.transaction(async (tx) => {
      if (memberIds.length) {
        await tx
          .delete(conversationMembers)
          .where(inArray(conversationMembers.memberId, memberIds));
        await tx.delete(taskAssignees).where(inArray(taskAssignees.memberId, memberIds));
        // Org cleanup: anyone reporting to a removed member now reports to no-one.
        await tx
          .update(members)
          .set({ reportsTo: null })
          .where(
            and(eq(members.workspaceId, targetWs), inArray(members.reportsTo, memberIds)),
          );
        await tx.delete(members).where(inArray(members.id, memberIds));
      }
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, targetWs),
            eq(workspaceMembers.userId, targetUser),
          ),
        );
      // If the removed user had this workspace selected in any session, clear it
      // so they don't land on a workspace they no longer belong to.
      await tx
        .update(sessions)
        .set({ currentWorkspaceId: null })
        .where(
          and(eq(sessions.userId, targetUser), eq(sessions.currentWorkspaceId, targetWs)),
        );
    });

    return { ok: true, selfLeave: isSelfLeave };
  });

  // Delete an entire workspace and everything scoped to it. Admin-only and
  // gated behind an explicit handle-confirmation in the body to make this
  // hard to trigger by accident. Cascades through every workspace-scoped
  // table. Agents' DB rows are removed but their Docker runtimes/home dirs
  // are NOT torn down here — uninstall agents first if you need that.
  app.delete("/workspaces/:id", async (req, reply) => {
    const targetWs = (req.params as { id: string }).id;
    const { user } = req.auth!;
    const body = z.object({ confirmHandle: z.string().min(1) }).parse(req.body);

    const me = await loadWorkspaceRole(targetWs, user.id);
    if (!me || me.role !== "admin") return reply.code(403).send({ error: "admin_only" });

    const [ws] = await db
      .select({ handle: workspaces.handle })
      .from(workspaces)
      .where(eq(workspaces.id, targetWs))
      .limit(1);
    if (!ws) return reply.code(404).send({ error: "not_found" });
    if (body.confirmHandle !== ws.handle) {
      return reply.code(400).send({ error: "handle_mismatch" });
    }

    const convRows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.workspaceId, targetWs));
    const convIds = convRows.map((r) => r.id);
    const taskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.workspaceId, targetWs));
    const taskIds = taskRows.map((r) => r.id);
    const agentRows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.workspaceId, targetWs));
    const agentIds = agentRows.map((r) => r.id);

    await db.transaction(async (tx) => {
      if (convIds.length) {
        const msgIds = (
          await tx.select({ id: messages.id }).from(messages).where(inArray(messages.conversationId, convIds))
        ).map((r) => r.id);
        if (msgIds.length) await tx.delete(reactions).where(inArray(reactions.messageId, msgIds));
        await tx.delete(messages).where(inArray(messages.conversationId, convIds));
        await tx.delete(conversationMembers).where(inArray(conversationMembers.conversationId, convIds));
        await tx.delete(conversations).where(inArray(conversations.id, convIds));
      }
      if (taskIds.length) {
        await tx.delete(taskAssignees).where(inArray(taskAssignees.taskId, taskIds));
        await tx.delete(tasks).where(inArray(tasks.id, taskIds));
      }
      if (agentIds.length) {
        await tx.delete(agents).where(inArray(agents.id, agentIds));
      }
      await tx.delete(members).where(eq(members.workspaceId, targetWs));
      await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, targetWs));
      // Repoint sessions parked on this workspace.
      await tx
        .update(sessions)
        .set({ currentWorkspaceId: null })
        .where(eq(sessions.currentWorkspaceId, targetWs));
      await tx.delete(workspaces).where(eq(workspaces.id, targetWs));
    });

    return { ok: true };
  });
}

// Load the caller's role in a workspace, or null if they don't belong.
async function loadWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<{ role: string } | null> {
  const [wm] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    )
    .limit(1);
  return wm ?? null;
}

// True if `userId` is the only admin left in the workspace.
async function isLastAdmin(workspaceId: string, userId: string): Promise<boolean> {
  const others = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "admin"),
        ne(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  return others.length === 0;
}
