import { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  users,
  invites,
  members,
  conversations,
  conversationMembers,
  workspaces,
  workspaceMembers,
  sessions,
} from "../db/schema.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  ensureUserMember,
  loadSession,
  COOKIE_NAME,
} from "../auth/session.js";
import { id, rawToken } from "../lib/ids.js";
import { config } from "../lib/config.js";

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  workspaceName: z.string().min(1).max(100),
  workspaceHandle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const InviteBody = z.object({ email: z.string().email() });

const AcceptInviteBody = z.object({
  token: z.string().min(10),
  name: z.string().min(1).max(100),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  password: z.string().min(8),
});

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // ─────────── signup: creates a user + a brand-new workspace ───────────
  app.post("/auth/signup", async (req, reply) => {
    const body = SignupBody.parse(req.body);

    const [existUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existUser) return reply.code(409).send({ error: "email_in_use" });

    const [existHandle] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, body.handle))
      .limit(1);
    if (existHandle) return reply.code(409).send({ error: "handle_in_use" });

    const [existWsHandle] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.handle, body.workspaceHandle))
      .limit(1);
    if (existWsHandle) return reply.code(409).send({ error: "workspace_handle_in_use" });

    const uid = id("u");
    await db.insert(users).values({
      id: uid,
      email: body.email,
      name: body.name,
      handle: body.handle,
      passwordHash: await hashPassword(body.password),
      avatarColor: pickColor(body.handle),
    });

    const wsId = id("w");
    await db.insert(workspaces).values({
      id: wsId,
      name: body.workspaceName,
      handle: body.workspaceHandle,
      createdBy: uid,
    });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: wsId, userId: uid, role: "admin" });

    const memberId = await ensureUserMember(wsId, uid);

    // Bootstrap a #general channel in the new workspace.
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

    const sid = await createSession(uid, wsId);
    setSessionCookie(reply, sid);
    return reply.send({
      ok: true,
      user: publicUser({
        id: uid,
        email: body.email,
        name: body.name,
        handle: body.handle,
        avatarColor: pickColor(body.handle),
        createdAt: new Date(),
      }),
      memberId,
      workspace: { id: wsId, name: body.workspaceName, handle: body.workspaceHandle },
    });
  });

  // ─────────── login: picks a default workspace if the user has any ──────
  app.post("/auth/login", async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!u) return reply.code(401).send({ error: "invalid_credentials" });
    if (!(await verifyPassword(body.password, u.passwordHash)))
      return reply.code(401).send({ error: "invalid_credentials" });

    const [wm] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, u.id))
      .limit(1);
    const wsId = wm?.workspaceId ?? null;
    const memberId = wsId ? await ensureUserMember(wsId, u.id) : null;

    const sid = await createSession(u.id, wsId);
    setSessionCookie(reply, sid);
    return { ok: true, user: publicUser(u), memberId, workspaceId: wsId };
  });

  app.post("/auth/logout", async (req, reply) => {
    const sid = req.cookies[COOKIE_NAME];
    if (sid) await deleteSession(sid);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ─────────── /me: user + current workspace + all workspaces ──────────
  app.get("/me", { preHandler: requireAuth }, async (req) => {
    const { user, memberId, workspaceId } = req.auth!;

    const wsRows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        handle: workspaces.handle,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id));

    return {
      user: publicUser(user),
      memberId,
      workspaceId,
      workspaces: wsRows,
    };
  });

  // ─────────── invites: always scoped to the caller's current workspace ──
  app.post("/auth/invite", { preHandler: requireAuth }, async (req, reply) => {
    const body = InviteBody.parse(req.body);
    const { memberId, workspaceId } = req.auth!;
    if (!workspaceId || !memberId) return reply.code(409).send({ error: "no_workspace" });
    const token = rawToken(40);
    const invId = id("inv");
    await db.insert(invites).values({
      id: invId,
      workspaceId,
      email: body.email,
      token,
      invitedBy: memberId,
    });
    const url = `${config.publicBaseUrl}/invite/${token}`;
    if (!config.smtpUrl) {
      req.log.info({ email: body.email, url }, "invite generated (no SMTP, URL in log)");
    }
    return { ok: true, inviteUrl: url, email: body.email };
  });

  app.get("/invite/:token", async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const [inv] = await db.select().from(invites).where(eq(invites.token, token)).limit(1);
    if (!inv) return reply.code(404).send({ error: "not_found" });
    if (inv.acceptedAt) return reply.code(410).send({ error: "already_accepted" });
    const [ws] = await db
      .select({ id: workspaces.id, name: workspaces.name, handle: workspaces.handle })
      .from(workspaces)
      .where(eq(workspaces.id, inv.workspaceId))
      .limit(1);

    // If the caller is already logged in, tell the UI whether they can
    // one-click-join (yes if already a member of the ws, or if their email
    // matches the invite).
    const sid = req.cookies[COOKIE_NAME];
    let viewer: { userId: string; email: string; alreadyMember: boolean } | null = null;
    if (sid) {
      const s = await loadSession(sid);
      if (s) {
        const [existingWm] = await db
          .select()
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.userId, s.userId),
              eq(workspaceMembers.workspaceId, inv.workspaceId),
            ),
          )
          .limit(1);
        viewer = {
          userId: s.userId,
          email: s.user.email,
          alreadyMember: !!existingWm,
        };
      }
    }
    return { email: inv.email, workspace: ws, viewer };
  });

  // One-click join for already-authenticated users. Auto-add to the
  // workspace + every public channel. The user only sees this path from the
  // UI when they're logged in and don't yet belong to the workspace.
  app.post("/auth/accept-invite-as-self", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ token: z.string().min(10) }).parse(req.body);
    const { user } = req.auth!;
    const sid = req.cookies[COOKIE_NAME];
    if (!sid) return reply.code(401).send({ error: "unauthenticated" });

    const [inv] = await db.select().from(invites).where(eq(invites.token, body.token)).limit(1);
    if (!inv) return reply.code(404).send({ error: "not_found" });
    if (inv.acceptedAt) return reply.code(410).send({ error: "already_accepted" });

    await db
      .insert(workspaceMembers)
      .values({ workspaceId: inv.workspaceId, userId: user.id, role: "member" })
      .onConflictDoNothing();
    const memberId = await ensureUserMember(inv.workspaceId, user.id);

    const publicChannels = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, inv.workspaceId),
          eq(conversations.kind, "channel"),
          eq(conversations.isPrivate, false),
        ),
      );
    if (publicChannels.length) {
      await db
        .insert(conversationMembers)
        .values(
          publicChannels.map((c) => ({
            conversationId: c.id,
            memberId,
            role: "member" as const,
          })),
        )
        .onConflictDoNothing();
    }

    await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
    // Switch them into the newly-joined workspace so the UI lands there.
    await db
      .update(sessions)
      .set({ currentWorkspaceId: inv.workspaceId })
      .where(eq(sessions.id, sid));

    return { ok: true, memberId, workspaceId: inv.workspaceId };
  });

  // Accepting an invite — creates the user if new, adds them to the workspace,
  // and bootstraps membership in every public channel in that workspace.
  app.post("/auth/accept-invite", async (req, reply) => {
    const body = AcceptInviteBody.parse(req.body);
    const [inv] = await db.select().from(invites).where(eq(invites.token, body.token)).limit(1);
    if (!inv) return reply.code(404).send({ error: "not_found" });
    if (inv.acceptedAt) return reply.code(410).send({ error: "already_accepted" });

    // Reuse an existing user if the email already signed up elsewhere; else create.
    let uid: string;
    const [existE] = await db.select().from(users).where(eq(users.email, inv.email)).limit(1);
    if (existE) {
      uid = existE.id;
    } else {
      const [existH] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.handle, body.handle))
        .limit(1);
      if (existH) return reply.code(409).send({ error: "handle_in_use" });
      uid = id("u");
      await db.insert(users).values({
        id: uid,
        email: inv.email,
        name: body.name,
        handle: body.handle,
        passwordHash: await hashPassword(body.password),
        avatarColor: pickColor(body.handle),
      });
    }

    await db
      .insert(workspaceMembers)
      .values({ workspaceId: inv.workspaceId, userId: uid, role: "member" })
      .onConflictDoNothing();
    const memberId = await ensureUserMember(inv.workspaceId, uid);

    const publicChannels = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, inv.workspaceId),
          eq(conversations.kind, "channel"),
          eq(conversations.isPrivate, false),
        ),
      );
    if (publicChannels.length) {
      await db
        .insert(conversationMembers)
        .values(
          publicChannels.map((c) => ({
            conversationId: c.id,
            memberId,
            role: "member" as const,
          })),
        )
        .onConflictDoNothing();
    }

    await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));

    const sid = await createSession(uid, inv.workspaceId);
    setSessionCookie(reply, sid);
    return { ok: true, memberId, workspaceId: inv.workspaceId };
  });
}

function publicUser(u: {
  id: string;
  email: string;
  name: string;
  handle: string;
  avatarColor: string;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    handle: u.handle,
    avatarColor: u.avatarColor,
    createdAt: u.createdAt,
  };
}

const COLORS = ["slate", "amber", "teal", "rose", "violet", "lime", "sky", "orange"];
function pickColor(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}
