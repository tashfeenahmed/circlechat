import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  auditEvents,
  conversationMembers,
  conversations,
  members,
  serviceAccounts,
  sessions,
  ssoConnections,
  users,
  workspaceMembers,
  workspaceRoles,
  workspaces,
  workflows,
} from "../db/schema.js";
import { requireWorkspace, createSession, ensureUserMember, hashPassword, setSessionCookie } from "../auth/session.js";
import { requirePermission, workspaceAccess, writeAudit } from "../lib/access-control.js";
import { config } from "../lib/config.js";
import { decryptSecret, encryptSecret } from "../lib/secret-box.js";
import { id, rawToken } from "../lib/ids.js";
import { redis } from "../lib/redis.js";
import { startWorkflowRun } from "../lib/workflow-engine.js";

const RoleBody = z.object({
  key: z.string().min(2).max(40).regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().min(1).max(80),
  permissions: z.array(z.enum([
    "workspace.read", "workspace.write", "channels.write", "runs.control",
    "apps.request_publish", "approvals.decide", "audit.export", "access.manage",
  ])).max(30),
});

const SsoBody = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1).max(240),
  clientSecret: z.string().min(1).max(4_000).optional(),
  domains: z.array(z.string().min(1).max(255)).max(50).default([]),
  defaultRole: z.string().min(2).max(40).default("member"),
  enabled: z.boolean().default(true),
});

type OidcDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function callbackUrl(): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/auth/sso/callback`;
}

async function admin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await requirePermission(req, "*")) return true;
  reply.code(403).send({ error: "admin_only" });
  return false;
}

async function discovery(issuer: string): Promise<OidcDiscovery> {
  const url = new URL(issuer);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("oidc_issuer_must_use_https");
  if (url.username || url.password) throw new Error("oidc_issuer_invalid");
  const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`oidc_discovery_${response.status}`);
  const parsed = z.object({ authorization_endpoint: z.string().url(), token_endpoint: z.string().url(), userinfo_endpoint: z.string().url() }).parse(await response.json());
  for (const endpoint of Object.values(parsed)) {
    const next = new URL(endpoint);
    if (next.origin !== url.origin) throw new Error("oidc_cross_origin_endpoint");
  }
  return parsed;
}

export default async function enterpriseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/enterprise", async (req) => {
    const workspaceId = req.auth!.workspaceId!;
    const [workspace, roles, accounts, sso, access] = await Promise.all([
      db.select({ retentionDays: workspaces.retentionDays, dataResidency: workspaces.dataResidency }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1).then((rows) => rows[0]),
      db.select().from(workspaceRoles).where(eq(workspaceRoles.workspaceId, workspaceId)).orderBy(workspaceRoles.name),
      db.select({ id: serviceAccounts.id, name: serviceAccounts.name, scopesJson: serviceAccounts.scopesJson, lastUsedAt: serviceAccounts.lastUsedAt, expiresAt: serviceAccounts.expiresAt, revokedAt: serviceAccounts.revokedAt, createdAt: serviceAccounts.createdAt }).from(serviceAccounts).where(eq(serviceAccounts.workspaceId, workspaceId)).orderBy(desc(serviceAccounts.createdAt)),
      db.select().from(ssoConnections).where(eq(ssoConnections.workspaceId, workspaceId)).limit(1).then((rows) => rows[0]),
      workspaceAccess(workspaceId, req.auth!.userId),
    ]);
    return {
      workspace,
      access,
      builtInRoles: [
        { key: "admin", name: "Admin", permissions: ["*"] },
        { key: "member", name: "Member", permissions: ["workspace.read", "workspace.write", "runs.control", "apps.request_publish", "approvals.decide"] },
        { key: "guest", name: "Guest", permissions: ["workspace.read", "channels.write"] },
      ],
      roles,
      serviceAccounts: accounts,
      sso: sso ? { id: sso.id, issuer: sso.issuer, clientId: sso.clientId, domains: sso.domainsJson, defaultRole: sso.defaultRole, enabled: sso.enabled, hasSecret: true } : null,
    };
  });

  app.put("/enterprise/governance", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const body = z.object({ retentionDays: z.number().int().min(1).max(3_650).nullable(), dataResidency: z.string().min(2).max(32).regex(/^[a-z0-9_-]+$/i) }).parse(req.body);
    await db.update(workspaces).set({ retentionDays: body.retentionDays, dataResidency: body.dataResidency }).where(eq(workspaces.id, req.auth!.workspaceId!));
    await writeAudit({ workspaceId: req.auth!.workspaceId!, actorId: req.auth!.memberId!, action: "governance.updated", targetType: "workspace", targetId: req.auth!.workspaceId!, meta: body, ip: req.ip });
    return { ok: true, ...body };
  });

  app.post("/enterprise/roles", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const body = RoleBody.parse(req.body);
    if (["admin", "member", "guest"].includes(body.key)) return reply.code(409).send({ error: "system_role" });
    const roleId = id("role");
    await db.insert(workspaceRoles).values({ id: roleId, workspaceId: req.auth!.workspaceId!, key: body.key, name: body.name, permissionsJson: body.permissions, createdBy: req.auth!.memberId! })
      .onConflictDoUpdate({ target: [workspaceRoles.workspaceId, workspaceRoles.key], set: { name: body.name, permissionsJson: body.permissions, updatedAt: new Date() } });
    await writeAudit({ workspaceId: req.auth!.workspaceId!, actorId: req.auth!.memberId!, action: "role.upserted", targetType: "role", targetId: body.key, meta: { permissions: body.permissions }, ip: req.ip });
    const [role] = await db.select().from(workspaceRoles).where(and(eq(workspaceRoles.workspaceId, req.auth!.workspaceId!), eq(workspaceRoles.key, body.key))).limit(1);
    return reply.code(201).send({ role });
  });

  app.delete("/enterprise/roles/:key", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const key = (req.params as { key: string }).key;
    if (["admin", "member", "guest"].includes(key)) return reply.code(409).send({ error: "system_role" });
    const [used] = await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, req.auth!.workspaceId!), eq(workspaceMembers.role, key))).limit(1);
    if (used) return reply.code(409).send({ error: "role_in_use" });
    await db.delete(workspaceRoles).where(and(eq(workspaceRoles.workspaceId, req.auth!.workspaceId!), eq(workspaceRoles.key, key)));
    return { ok: true };
  });

  app.post("/enterprise/service-accounts", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const body = z.object({ name: z.string().min(1).max(100), scopes: z.array(z.string().min(1).max(80)).min(1).max(50), expiresAt: z.string().datetime().nullable().optional() }).parse(req.body);
    const token = `cc_sa_${rawToken(48)}`;
    const accountId = id("svc");
    await db.insert(serviceAccounts).values({ id: accountId, workspaceId: req.auth!.workspaceId!, name: body.name, tokenHash: sha(token), scopesJson: body.scopes, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, createdBy: req.auth!.memberId! });
    await writeAudit({ workspaceId: req.auth!.workspaceId!, actorId: req.auth!.memberId!, action: "service_account.created", targetType: "service_account", targetId: accountId, meta: { scopes: body.scopes }, ip: req.ip });
    return reply.code(201).send({ account: { id: accountId, name: body.name, scopes: body.scopes, expiresAt: body.expiresAt ?? null }, token });
  });

  app.post("/enterprise/service-accounts/:id/revoke", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const accountId = (req.params as { id: string }).id;
    const result = await db.update(serviceAccounts).set({ revokedAt: new Date() }).where(and(eq(serviceAccounts.id, accountId), eq(serviceAccounts.workspaceId, req.auth!.workspaceId!))).returning({ id: serviceAccounts.id });
    if (!result.length) return reply.code(404).send({ error: "service_account_not_found" });
    return { ok: true };
  });

  app.put("/enterprise/sso", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const body = SsoBody.parse(req.body);
    // Discovery failures are the operator's input being wrong (non-https
    // issuer, unreachable/malformed metadata) — a 400 with the reason, not a
    // 500 stack trace.
    try {
      await discovery(body.issuer);
    } catch (e) {
      return reply.code(400).send({ error: "oidc_discovery_failed", detail: (e as Error).message.slice(0, 200) });
    }
    const [existing] = await db.select().from(ssoConnections).where(eq(ssoConnections.workspaceId, req.auth!.workspaceId!)).limit(1);
    if (!existing && !body.clientSecret) return reply.code(400).send({ error: "client_secret_required" });
    const secret = body.clientSecret ? encryptSecret({ clientSecret: body.clientSecret }) : existing!.clientSecretCiphertext;
    await db.insert(ssoConnections).values({
      id: existing?.id ?? id("sso"), workspaceId: req.auth!.workspaceId!, issuer: body.issuer.replace(/\/$/, ""),
      clientId: body.clientId, clientSecretCiphertext: secret, domainsJson: body.domains.map((domain) => domain.toLowerCase()),
      defaultRole: body.defaultRole, enabled: body.enabled, createdBy: req.auth!.memberId!,
    }).onConflictDoUpdate({ target: ssoConnections.workspaceId, set: {
      issuer: body.issuer.replace(/\/$/, ""), clientId: body.clientId, clientSecretCiphertext: secret,
      domainsJson: body.domains.map((domain) => domain.toLowerCase()), defaultRole: body.defaultRole,
      enabled: body.enabled, updatedAt: new Date(),
    } });
    await writeAudit({ workspaceId: req.auth!.workspaceId!, actorId: req.auth!.memberId!, action: "sso.configured", targetType: "sso", targetId: existing?.id, meta: { issuer: body.issuer, domains: body.domains, enabled: body.enabled }, ip: req.ip });
    return { ok: true };
  });

  app.get("/enterprise/audit", async (req, reply) => {
    const access = await workspaceAccess(req.auth!.workspaceId!, req.auth!.userId);
    if (!access || (!access.permissions.includes("*") && !access.permissions.includes("audit.export"))) return reply.code(403).send({ error: "permission_denied" });
    const query = z.object({ format: z.enum(["json", "csv"]).default("json"), days: z.coerce.number().int().min(1).max(3650).default(30) }).parse(req.query);
    const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, req.auth!.workspaceId!), gt(auditEvents.createdAt, new Date(Date.now() - query.days * 86_400_000)))).orderBy(desc(auditEvents.createdAt)).limit(50_000);
    if (query.format === "json") return { events: rows };
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = ["created_at,actor_type,actor_id,action,target_type,target_id,meta_json", ...rows.map((row) => [row.createdAt.toISOString(), row.actorType, row.actorId, row.action, row.targetType, row.targetId ?? "", JSON.stringify(row.metaJson)].map(escape).join(","))].join("\n");
    return reply.header("content-disposition", "attachment; filename=circlechat-audit.csv").type("text/csv; charset=utf-8").send(csv);
  });
}

export async function enterprisePublicRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/sso/:workspaceHandle", async (req, reply) => {
    const handle = (req.params as { workspaceHandle: string }).workspaceHandle;
    const [row] = await db.select({ connection: ssoConnections, workspace: workspaces })
      .from(ssoConnections).innerJoin(workspaces, eq(workspaces.id, ssoConnections.workspaceId))
      .where(and(eq(workspaces.handle, handle), eq(ssoConnections.enabled, true))).limit(1);
    if (!row) return reply.code(404).send({ error: "sso_not_configured" });
    const doc = await discovery(row.connection.issuer);
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    await redis.set(`cc:oidc:${state}`, JSON.stringify({ connectionId: row.connection.id, verifier }), "EX", 600);
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", row.connection.clientId);
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return reply.redirect(url.toString());
  });

  app.get("/auth/sso/callback", async (req, reply) => {
    const query = z.object({ code: z.string().min(1), state: z.string().min(20) }).parse(req.query);
    const stored = await redis.getdel(`cc:oidc:${query.state}`);
    if (!stored) return reply.code(400).send({ error: "oidc_state_invalid" });
    const state = z.object({ connectionId: z.string(), verifier: z.string() }).parse(JSON.parse(stored));
    const [connection] = await db.select().from(ssoConnections).where(and(eq(ssoConnections.id, state.connectionId), eq(ssoConnections.enabled, true))).limit(1);
    if (!connection) return reply.code(404).send({ error: "sso_not_configured" });
    const doc = await discovery(connection.issuer);
    const { clientSecret } = decryptSecret<{ clientSecret: string }>(connection.clientSecretCiphertext);
    const tokenResponse = await fetch(doc.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: callbackUrl(), client_id: connection.clientId, client_secret: clientSecret, code_verifier: state.verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) return reply.code(401).send({ error: "oidc_token_exchange_failed" });
    const token = z.object({ access_token: z.string().min(1) }).parse(await tokenResponse.json());
    const userResponse = await fetch(doc.userinfo_endpoint, { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!userResponse.ok) return reply.code(401).send({ error: "oidc_userinfo_failed" });
    const identity = z.object({ sub: z.string(), email: z.string().email(), email_verified: z.boolean().optional(), name: z.string().optional(), preferred_username: z.string().optional() }).parse(await userResponse.json());
    if (identity.email_verified === false) return reply.code(403).send({ error: "oidc_email_unverified" });
    const email = identity.email.toLowerCase();
    const domain = email.split("@")[1];
    if (connection.domainsJson.length && !connection.domainsJson.includes(domain)) return reply.code(403).send({ error: "oidc_domain_not_allowed" });
    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      const userId = id("u");
      const baseHandle = (identity.preferred_username ?? email.split("@")[0]).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 30) || "sso-user";
      let handle = baseHandle;
      if ((await db.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1)).length) handle = `${baseHandle}-${rawToken(4).toLowerCase()}`.slice(0, 40);
      await db.insert(users).values({ id: userId, email, name: identity.name ?? email.split("@")[0], handle, passwordHash: await hashPassword(rawToken(48)), avatarColor: "slate" });
      [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    }
    await db.insert(workspaceMembers).values({ workspaceId: connection.workspaceId, userId: user.id, role: connection.defaultRole }).onConflictDoNothing();
    const memberId = await ensureUserMember(connection.workspaceId, user.id);
    if (connection.defaultRole !== "guest") {
      const channels = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.workspaceId, connection.workspaceId), eq(conversations.kind, "channel"), eq(conversations.isPrivate, false)));
      if (channels.length) await db.insert(conversationMembers).values(channels.map((channel) => ({ conversationId: channel.id, memberId, role: "member" }))).onConflictDoNothing();
    }
    const sid = await createSession(user.id, connection.workspaceId);
    setSessionCookie(reply, sid);
    await writeAudit({ workspaceId: connection.workspaceId, actorId: memberId, action: "sso.login", targetType: "user", targetId: user.id, meta: { issuer: connection.issuer, subject: identity.sub }, ip: req.ip });
    return reply.redirect(`${config.publicBaseUrl.replace(/\/$/, "")}/`);
  });
}

export async function serviceApiRoutes(app: FastifyInstance): Promise<void> {
  async function authenticate(req: FastifyRequest, reply: FastifyReply, scope?: string) {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token.startsWith("cc_sa_")) { reply.code(401).send({ error: "service_token_required" }); return null; }
    const [account] = await db.select().from(serviceAccounts).where(and(eq(serviceAccounts.tokenHash, sha(token)), isNull(serviceAccounts.revokedAt))).limit(1);
    if (!account || (account.expiresAt && account.expiresAt <= new Date())) { reply.code(401).send({ error: "service_token_invalid" }); return null; }
    if (scope && !account.scopesJson.includes(scope) && !account.scopesJson.includes("*")) { reply.code(403).send({ error: "service_scope_required", scope }); return null; }
    await db.update(serviceAccounts).set({ lastUsedAt: new Date() }).where(eq(serviceAccounts.id, account.id));
    await writeAudit({ workspaceId: account.workspaceId, actorType: "service", actorId: account.id, action: "service_account.authenticated", targetType: "service_account", targetId: account.id, ip: req.ip });
    return account;
  }

  app.get("/service-api/whoami", async (req, reply) => {
    const account = await authenticate(req, reply);
    if (!account) return;
    return { account: { id: account.id, name: account.name, workspaceId: account.workspaceId, scopes: account.scopesJson } };
  });

  app.get("/service-api/workflows", async (req, reply) => {
    const account = await authenticate(req, reply, "workflows.read");
    if (!account) return;
    const rows = await db.select({ id: workflows.id, name: workflows.name, status: workflows.status, triggerType: workflows.triggerType, version: workflows.version })
      .from(workflows).where(eq(workflows.workspaceId, account.workspaceId)).orderBy(workflows.name);
    return { workflows: rows };
  });

  app.post("/service-api/workflows/:id/runs", async (req, reply) => {
    const account = await authenticate(req, reply, "workflows.run");
    if (!account) return;
    const workflowId = (req.params as { id: string }).id;
    const body = z.object({ input: z.record(z.string(), z.unknown()).default({}) }).parse(req.body ?? {});
    try {
      const runId = await startWorkflowRun({ workflowId, workspaceId: account.workspaceId, payload: body.input, createdBy: account.id });
      await writeAudit({ workspaceId: account.workspaceId, actorType: "service", actorId: account.id, action: "service_account.workflow_started", targetType: "workflow_run", targetId: runId, meta: { workflowId }, ip: req.ip });
      return reply.code(202).send({ runId });
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message === "workflow_not_found" ? 404 : 409).send({ error: message });
    }
  });
}
