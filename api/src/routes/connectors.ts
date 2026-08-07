import { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { agentConnectorGrants, agents, connectors } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { checkConnector, invokeConnector } from "../lib/connector-runtime.js";
import { config } from "../lib/config.js";
import { id } from "../lib/ids.js";
import { decryptSecret, encryptSecret } from "../lib/secret-box.js";

const Secret = z.object({
  bearerToken: z.string().max(20_000).optional(),
  oauthAccessToken: z.string().max(20_000).optional(),
  oauthRefreshToken: z.string().max(20_000).optional(),
  oauthExpiresAt: z.string().optional(),
  clientSecret: z.string().max(20_000).optional(),
  headers: z.record(z.string(), z.string().max(20_000)).optional(),
});

const Create = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  kind: z.enum(["http", "mcp"]),
  baseUrl: z.string().url(),
  authType: z.enum(["none", "bearer", "header", "oauth2"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: Secret.optional(),
});

const Patch = Create.partial();

function publicConnector<T extends typeof connectors.$inferSelect>(connector: T): Omit<T, "secretCiphertext"> & { hasSecret: boolean } {
  const { secretCiphertext, ...rest } = connector;
  return { ...rest, hasSecret: !!secretCiphertext };
}

function oauthConfig(connector: typeof connectors.$inferSelect): {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
} {
  const oauth = (connector.configJson.oauth ?? {}) as Record<string, unknown>;
  const parsed = z
    .object({
      authorizationUrl: z.string().url(),
      tokenUrl: z.string().url(),
      clientId: z.string().min(1),
      scopes: z.array(z.string()).default([]),
    })
    .parse(oauth);
  return parsed;
}

export default async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/connectors", { preHandler: requireWorkspace }, async (req) => {
    const workspaceId = req.auth!.workspaceId!;
    const rows = await db.select().from(connectors).where(eq(connectors.workspaceId, workspaceId));
    const ids = rows.map((row) => row.id);
    const grants = ids.length
      ? await db.select().from(agentConnectorGrants).where(inArray(agentConnectorGrants.connectorId, ids))
      : [];
    return {
      connectors: rows.map((row) => ({
        ...publicConnector(row),
        grants: grants.filter((grant) => grant.connectorId === row.id),
      })),
    };
  });

  app.post("/connectors", { preHandler: requireWorkspace }, async (req, reply) => {
    const body = Create.parse(req.body);
    const url = new URL(body.baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      return reply.code(400).send({ error: "connector_url_invalid" });
    }
    const connectorId = id("conn");
    await db.insert(connectors).values({
      id: connectorId,
      workspaceId: req.auth!.workspaceId!,
      name: body.name,
      description: body.description ?? "",
      kind: body.kind,
      baseUrl: body.baseUrl,
      authType: body.authType ?? "none",
      configJson: body.config ?? {},
      secretCiphertext: body.secret ? encryptSecret(body.secret) : null,
      createdBy: req.auth!.memberId!,
    });
    const [created] = await db.select().from(connectors).where(eq(connectors.id, connectorId)).limit(1);
    return reply.code(201).send({ connector: publicConnector(created) });
  });

  app.patch("/connectors/:id", { preHandler: requireWorkspace }, async (req, reply) => {
    const connectorId = (req.params as { id: string }).id;
    const body = Patch.parse(req.body);
    const [existing] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "connector_not_found" });
    if (body.baseUrl) {
      const url = new URL(body.baseUrl);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
        return reply.code(400).send({ error: "connector_url_invalid" });
      }
    }
    await db
      .update(connectors)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.authType !== undefined ? { authType: body.authType } : {}),
        ...(body.config !== undefined ? { configJson: body.config } : {}),
        ...(body.secret !== undefined ? { secretCiphertext: encryptSecret(body.secret) } : {}),
        status: "unchecked",
        updatedAt: new Date(),
      })
      .where(eq(connectors.id, connectorId));
    const [updated] = await db.select().from(connectors).where(eq(connectors.id, connectorId)).limit(1);
    return { connector: publicConnector(updated) };
  });

  app.delete("/connectors/:id", { preHandler: requireWorkspace }, async (req, reply) => {
    const connectorId = (req.params as { id: string }).id;
    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "connector_not_found" });
    await db.delete(agentConnectorGrants).where(eq(agentConnectorGrants.connectorId, connectorId));
    await db.delete(connectors).where(eq(connectors.id, connectorId));
    return reply.code(204).send();
  });

  app.post("/connectors/:id/check", { preHandler: requireWorkspace }, async (req, reply) => {
    const connectorId = (req.params as { id: string }).id;
    const [connector] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!connector) return reply.code(404).send({ error: "connector_not_found" });
    const result = await checkConnector(connector);
    await db
      .update(connectors)
      .set({
        status: result.ok ? "healthy" : "error",
        lastCheckedAt: new Date(),
        lastError: result.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(connectors.id, connector.id));
    return result;
  });

  app.post("/connectors/:id/invoke", { preHandler: requireWorkspace }, async (req, reply) => {
    const connectorId = (req.params as { id: string }).id;
    const body = z
      .object({
        operation: z.string().optional(),
        method: z.string().optional(),
        path: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
      })
      .parse(req.body ?? {});
    const [connector] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!connector) return reply.code(404).send({ error: "connector_not_found" });
    return invokeConnector(connector, { ...body, input: {}, steps: {} });
  });

  app.put("/connectors/:id/grants/:agentId", { preHandler: requireWorkspace }, async (req, reply) => {
    const { id: connectorId, agentId } = req.params as { id: string; agentId: string };
    const body = z.object({ scopes: z.array(z.string().min(1).max(100)).max(100).default([]) }).parse(req.body ?? {});
    const [connector] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!connector || !agent) return reply.code(404).send({ error: "connector_or_agent_not_found" });
    await db
      .insert(agentConnectorGrants)
      .values({ connectorId, agentId, scopes: body.scopes, createdBy: req.auth!.memberId! })
      .onConflictDoUpdate({
        target: [agentConnectorGrants.connectorId, agentConnectorGrants.agentId],
        set: { scopes: body.scopes, createdBy: req.auth!.memberId!, createdAt: new Date() },
      });
    return { ok: true };
  });

  app.delete("/connectors/:id/grants/:agentId", { preHandler: requireWorkspace }, async (req, reply) => {
    const { id: connectorId, agentId } = req.params as { id: string; agentId: string };
    const [connector] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!connector) return reply.code(404).send({ error: "connector_not_found" });
    await db
      .delete(agentConnectorGrants)
      .where(and(eq(agentConnectorGrants.connectorId, connectorId), eq(agentConnectorGrants.agentId, agentId)));
    return reply.code(204).send();
  });

  // Generic OAuth 2 authorization-code flow. Provider-specific URLs/client id/
  // scopes live in public connector config; the client secret and resulting
  // tokens remain inside the encrypted credential envelope.
  app.post("/connectors/:id/oauth/start", { preHandler: requireWorkspace }, async (req, reply) => {
    const connectorId = (req.params as { id: string }).id;
    const [connector] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!connector) return reply.code(404).send({ error: "connector_not_found" });
    if (connector.authType !== "oauth2") return reply.code(400).send({ error: "connector_not_oauth" });
    const oauth = oauthConfig(connector);
    const redirectUri = `${config.publicBaseUrl.replace(/\/$/, "")}/api/connectors/oauth/callback`;
    const state = encryptSecret({
      connectorId: connector.id,
      workspaceId: connector.workspaceId,
      expiresAt: Date.now() + 10 * 60 * 1000,
      nonce: id("oauth"),
    });
    const url = new URL(oauth.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", oauth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    if (oauth.scopes.length) url.searchParams.set("scope", oauth.scopes.join(" "));
    return { authorizationUrl: url.toString() };
  });

  // Deliberately unauthenticated: the provider redirects the browser here.
  // The encrypted, short-lived state binds the callback to one workspace and
  // connector; no ambient session authority is used.
  app.get("/connectors/oauth/callback", async (req, reply) => {
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(req.query);
    let state: { connectorId: string; workspaceId: string; expiresAt: number };
    try { state = decryptSecret(query.state); } catch { return reply.code(400).send({ error: "oauth_state_invalid" }); }
    if (state.expiresAt < Date.now()) return reply.code(400).send({ error: "oauth_state_expired" });
    const [connector] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, state.connectorId), eq(connectors.workspaceId, state.workspaceId)))
      .limit(1);
    if (!connector) return reply.code(404).send({ error: "connector_not_found" });
    const oauth = oauthConfig(connector);
    const oldSecret = connector.secretCiphertext
      ? decryptSecret<Record<string, unknown>>(connector.secretCiphertext)
      : {};
    const clientSecret = typeof oldSecret.clientSecret === "string" ? oldSecret.clientSecret : "";
    const redirectUri = `${config.publicBaseUrl.replace(/\/$/, "")}/api/connectors/oauth/callback`;
    const response = await fetch(oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: query.code,
        client_id: oauth.clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const token = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof token.access_token !== "string") {
      return reply.code(400).send({ error: "oauth_token_exchange_failed" });
    }
    const expiresIn = Number(token.expires_in ?? 0);
    await db
      .update(connectors)
      .set({
        secretCiphertext: encryptSecret({
          ...oldSecret,
          oauthAccessToken: token.access_token,
          ...(typeof token.refresh_token === "string" ? { oauthRefreshToken: token.refresh_token } : {}),
          ...(expiresIn > 0 ? { oauthExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
        }),
        status: "healthy",
        lastCheckedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(connectors.id, connector.id));
    return reply.redirect(`${config.publicBaseUrl.replace(/\/$/, "")}/automation?oauth=connected`);
  });
}
