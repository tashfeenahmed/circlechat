import { FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions, users, members, workspaceMembers } from "../db/schema.js";
import { id, rawToken } from "../lib/ids.js";
import { config } from "../lib/config.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const COOKIE_NAME = "cc_session";

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export async function createSession(
  userId: string,
  currentWorkspaceId: string | null = null,
): Promise<string> {
  const sid = rawToken(48);
  await db.insert(sessions).values({
    id: sid,
    userId,
    currentWorkspaceId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return sid;
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sid));
}

export async function loadSession(
  sid: string,
): Promise<{
  userId: string;
  user: typeof users.$inferSelect;
  workspaceId: string | null;
  memberId: string | null;
} | null> {
  const [row] = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      currentWorkspaceId: sessions.currentWorkspaceId,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;

  let workspaceId = row.currentWorkspaceId;
  // If the session has no current workspace yet, pick any the user belongs to.
  if (!workspaceId) {
    const [wm] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, row.user.id))
      .limit(1);
    workspaceId = wm?.workspaceId ?? null;
    if (workspaceId) {
      await db
        .update(sessions)
        .set({ currentWorkspaceId: workspaceId })
        .where(eq(sessions.id, sid));
    }
  }

  let memberId: string | null = null;
  if (workspaceId) {
    const [m] = await db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.workspaceId, workspaceId),
          eq(members.kind, "user"),
          eq(members.refId, row.user.id),
        ),
      )
      .limit(1);
    memberId = m?.id ?? null;
  }

  return { userId: row.userId, user: row.user, workspaceId, memberId };
}

export function setSessionCookie(reply: FastifyReply, sid: string): void {
  reply.setCookie(COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.env === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    signed: false,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

export async function ensureUserMember(
  workspaceId: string,
  userId: string,
): Promise<string> {
  const [m] = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        eq(members.kind, "user"),
        eq(members.refId, userId),
      ),
    )
    .limit(1);
  if (m) return m.id;
  const memberId = id("m");
  await db
    .insert(members)
    .values({ id: memberId, workspaceId, kind: "user", refId: userId });
  return memberId;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      userId: string;
      user: typeof users.$inferSelect;
      workspaceId: string | null;
      memberId: string | null;
    };
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sid = req.cookies[COOKIE_NAME];
  if (!sid) {
    reply.code(401).send({ error: "unauthenticated" });
    return;
  }
  const s = await loadSession(sid);
  if (!s) {
    reply.code(401).send({ error: "unauthenticated" });
    return;
  }
  req.auth = s;
}

// Stricter guard: user must be attached to a specific workspace. Use this in
// every route that reads or writes workspace-scoped data.
export async function requireWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (!req.auth?.workspaceId || !req.auth.memberId) {
    reply.code(409).send({ error: "no_workspace_selected" });
  }
}

export { COOKIE_NAME };
