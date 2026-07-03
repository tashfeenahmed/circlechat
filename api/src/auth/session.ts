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
    // Tie Secure to the public URL scheme, not NODE_ENV. A production build
    // served over plain HTTP (e.g. a bare IP or localhost trial) would
    // otherwise set Secure and the browser would drop the session cookie,
    // making login silently fail to persist.
    secure: config.publicBaseUrl.startsWith("https"),
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
    // True when this request was authenticated via the spectator fallback —
    // a shared read-only identity, not a real logged-in user.
    spectator?: boolean;
  }
}

// ─────────── spectator mode ───────────
// SPECTATOR_MODE=on turns the instance into a public fishbowl: anonymous
// visitors are authenticated as one shared read-only user instead of getting
// 401s, so the whole app (channels, board, analytics, live events) renders
// without a login. Server-side the fallback identity may only GET — every
// mutating verb is refused before any route handler runs, which is what makes
// this safe regardless of what the UI disables. Real users with a session
// cookie are untouched, and login/signup stay usable (they don't run
// requireAuth). Fully dormant unless the env flag is set.
export function spectatorEnabled(): boolean {
  return process.env.SPECTATOR_MODE === "on";
}
const spectatorEmail = (): string => process.env.SPECTATOR_EMAIL || "spectator@circlechat.local";

// The fallback runs on every anonymous request, so cache the resolved identity
// briefly rather than hitting the DB three times per page asset.
let spectatorCache: { auth: NonNullable<FastifyRequest["auth"]>; at: number } | null = null;
const SPECTATOR_CACHE_MS = 60_000;

export async function loadSpectatorAuth(): Promise<NonNullable<FastifyRequest["auth"]> | null> {
  if (!spectatorEnabled()) return null;
  if (spectatorCache && Date.now() - spectatorCache.at < SPECTATOR_CACHE_MS) return spectatorCache.auth;
  const [u] = await db.select().from(users).where(eq(users.email, spectatorEmail())).limit(1);
  if (!u) return null; // flag on but no spectator account seeded → behave as off
  const [wm] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, u.id))
    .limit(1);
  const workspaceId = wm?.workspaceId ?? null;
  let memberId: string | null = null;
  if (workspaceId) {
    const [m] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.kind, "user"), eq(members.refId, u.id)))
      .limit(1);
    memberId = m?.id ?? null;
  }
  const auth = { userId: u.id, user: u, workspaceId, memberId };
  spectatorCache = { auth, at: Date.now() };
  return auth;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sid = req.cookies[COOKIE_NAME];
  const s = sid ? await loadSession(sid) : null;
  if (s) {
    req.auth = s;
    return;
  }
  const spec = await loadSpectatorAuth();
  if (spec) {
    if (!READ_METHODS.has(req.method)) {
      reply.code(403).send({ error: "spectator_read_only" });
      return;
    }
    req.auth = spec;
    req.spectator = true;
    return;
  }
  reply.code(401).send({ error: "unauthenticated" });
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
