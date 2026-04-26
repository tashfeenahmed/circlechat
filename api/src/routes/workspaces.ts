import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  workspaces,
  workspaceMembers,
  sessions,
  conversations,
  conversationMembers,
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
}
