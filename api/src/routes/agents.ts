import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  members,
  conversations,
  conversationMembers,
  agentRuns,
  memoryKv,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { id, rawToken } from "../lib/ids.js";
import { enqueueAgentEvent } from "../agents/enqueue.js";
import { scheduleAgentHeartbeat, cancelAgentHeartbeat } from "../agents/scheduler.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  kind: z.enum(["openclaw", "hermes", "custom"]),
  adapter: z.enum(["webhook", "socket"]),
  model: z.string().max(80).optional(),
  title: z.string().max(160).optional(),
  brief: z.string().max(2000).optional(),
  scopes: z.array(z.string()).optional(),
  callbackUrl: z.string().url().optional(),
  heartbeatIntervalSec: z.number().int().min(5).max(86400).optional(),
  channelIds: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const PatchBody = z.object({
  name: z.string().optional(),
  title: z.string().max(160).optional(),
  brief: z.string().max(2000).optional(),
  scopes: z.array(z.string()).optional(),
  callbackUrl: z.string().url().optional(),
  heartbeatIntervalSec: z.number().int().min(5).max(86400).optional(),
  model: z.string().max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const RegisterBody = z.object({ callbackUrl: z.string().url() });

// Declarative agent definition for export/import ("agent-as-code"). No secrets:
// bot tokens and callback URLs are never part of a spec.
const AgentSpec = z.object({
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  name: z.string().min(1).max(100),
  title: z.string().max(160).optional(),
  brief: z.string().max(2000).optional(),
  kind: z.enum(["openclaw", "hermes", "custom"]).optional(),
  adapter: z.enum(["webhook", "socket"]).optional(),
  model: z.string().max(80).optional(),
  scopes: z.array(z.string()).optional(),
  heartbeatIntervalSec: z.number().int().min(5).max(86400).optional(),
  avatarColor: z.string().max(20).optional(),
  // Handle of the agent this one reports to (org chart). Wired after creation.
  reportsTo: z.string().max(40).nullable().optional(),
});
type AgentSpecT = z.infer<typeof AgentSpec>;

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
  // Accept raw YAML bodies for the import endpoint (JSON { yaml } also works via
  // the default parser). Scoped to this plugin instance.
  app.addContentTypeParser(
    ["application/yaml", "text/yaml", "application/x-yaml", "text/plain"],
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  app.get("/agents", { preHandler: requireWorkspace }, async (req) => {
    const { workspaceId } = req.auth!;
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId!))
      .orderBy(desc(agents.createdAt));
    const refIds = rows.map((r) => r.id);
    const memberRows = refIds.length
      ? await db
          .select()
          .from(members)
          .where(
            and(
              eq(members.workspaceId, workspaceId!),
              eq(members.kind, "agent"),
              inArray(members.refId, refIds),
            ),
          )
      : [];
    const mmap = new Map(memberRows.map((m) => [m.refId, m.id]));
    return {
      agents: rows.map((a) => ({
        ...a,
        botToken: mask(a.botToken),
        memberId: mmap.get(a.id),
      })),
    };
  });

  app.post("/agents", { preHandler: requireWorkspace }, async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const { memberId, workspaceId } = req.auth!;

    const [existH] = await db
      .select()
      .from(agents)
      .where(
        and(eq(agents.workspaceId, workspaceId!), eq(agents.handle, body.handle)),
      )
      .limit(1);
    if (existH) return reply.code(409).send({ error: "handle_in_use" });

    const agentId = id("a");
    const botToken = `cc_${rawToken(32)}`;
    const scopes = body.scopes ?? ["channels.read", "channels.reply"];

    await db.insert(agents).values({
      id: agentId,
      workspaceId: workspaceId!,
      handle: body.handle,
      name: body.name,
      kind: body.kind,
      adapter: body.adapter,
      configJson: body.config ?? {},
      model: body.model ?? "",
      scopes,
      status: "provisioning",
      title: body.title ?? "",
      brief: body.brief ?? "",
      botToken,
      heartbeatIntervalSec: body.heartbeatIntervalSec ?? 30,
      callbackUrl: body.callbackUrl ?? null,
      createdBy: memberId!,
      avatarColor: pickColor(body.handle),
    });

    const agentMemberId = id("m");
    await db
      .insert(members)
      .values({ id: agentMemberId, workspaceId: workspaceId!, kind: "agent", refId: agentId });

    // Auto-join agent to picked channels (admin-marked).
    if (body.channelIds?.length) {
      await db
        .insert(conversationMembers)
        .values(
          body.channelIds.map((cid) => ({
            conversationId: cid,
            memberId: agentMemberId,
            role: "member" as const,
          })),
        )
        .onConflictDoNothing();
    }

    // If callback URL is set (OpenClaw) or adapter=socket (Hermes) and we're ready, schedule heartbeats.
    if (body.adapter === "webhook" && body.callbackUrl) {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      await scheduleAgentHeartbeat(agentId, body.heartbeatIntervalSec ?? 30);
    }
    // Sockets register by opening WS themselves — stay in "provisioning" until they do.

    return {
      id: agentId,
      memberId: agentMemberId,
      botToken,
      handle: body.handle,
    };
  });

  app.get("/agents/:id", { preHandler: requireWorkspace }, async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId } = req.auth!;
    const [a] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    const [mem] = await db
      .select()
      .from(members)
      .where(and(eq(members.kind, "agent"), eq(members.refId, aId)))
      .limit(1);
    const channels = await db
      .select({ conversation: conversations })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(eq(conversationMembers.memberId, mem?.id ?? ""));
    const recentRuns = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.agentId, aId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(25);
    return {
      agent: { ...a, botToken: mask(a.botToken), memberId: mem?.id },
      channels: channels.map((c) => c.conversation),
      recentRuns,
    };
  });

  app.patch("/agents/:id", { preHandler: requireWorkspace }, async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const body = PatchBody.parse(req.body);
    const { workspaceId } = req.auth!;
    const [a] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    await db.update(agents).set(body).where(eq(agents.id, aId));
    if (typeof body.heartbeatIntervalSec === "number") {
      await scheduleAgentHeartbeat(aId, body.heartbeatIntervalSec);
    }
    return { ok: true };
  });

  app.post("/agents/:id/test", { preHandler: requireWorkspace }, async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId } = req.auth!;
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    const runId = await enqueueAgentEvent(aId, { trigger: "test" });
    return { runId };
  });

  // Fire a *real* scheduled beat on demand — same trigger the cron uses every
  // heartbeatIntervalSec. Useful for poking an idle agent without waiting for
  // the next tick, and for debugging the full ambient/skip-guard path.
  app.post("/agents/:id/run-heartbeat", { preHandler: requireWorkspace }, async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId } = req.auth!;
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    const runId = await enqueueAgentEvent(aId, { trigger: "scheduled" });
    return { runId };
  });

  app.post("/agents/:id/pause", { preHandler: requireWorkspace }, async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId } = req.auth!;
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, aId));
    await cancelAgentHeartbeat(aId);
    return { ok: true };
  });

  app.post("/agents/:id/resume", { preHandler: requireWorkspace }, async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId } = req.auth!;
    const [a] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, aId));
    await scheduleAgentHeartbeat(aId, a.heartbeatIntervalSec);
    return { ok: true };
  });

  // OpenClaw / webhook registration (operator points the agent at CircleChat).
  app.post("/agents/:id/register", async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const body = RegisterBody.parse(req.body);
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const [a] = await db.select().from(agents).where(eq(agents.id, aId)).limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    if (a.botToken !== token) return reply.code(401).send({ error: "bad_token" });
    await db
      .update(agents)
      .set({ callbackUrl: body.callbackUrl, status: "idle" })
      .where(eq(agents.id, aId));
    await scheduleAgentHeartbeat(aId, a.heartbeatIntervalSec);
    return { ok: true };
  });

  // Agent run detail / feed
  app.get("/agent-runs/:id", { preHandler: requireWorkspace }, async (req, reply) => {
    const rId = (req.params as { id: string }).id;
    const { workspaceId } = req.auth!;
    const [row] = await db
      .select({ run: agentRuns })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(and(eq(agentRuns.id, rId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { run: row.run };
  });

  // Thin memory KV for agents
  app.get("/agents/:id/memory", { preHandler: requireWorkspace }, async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId } = req.auth!;
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    const rows = await db.select().from(memoryKv).where(eq(memoryKv.agentId, aId));
    return { memory: rows };
  });

  // ───── agent-as-code: declarative export / import (YAML) ─────
  // A reviewable, version-controllable definition of an agent (or a whole team
  // + reporting hierarchy). Secrets (bot tokens, callback URLs) are never
  // exported. Import is idempotent on handle: an existing handle is skipped.

  // Export one agent as a YAML spec.
  app.get("/agents/:id/export", { preHandler: requireWorkspace }, async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId } = req.auth!;
    const [a] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    const spec = await agentToSpec(a, workspaceId!);
    reply.header("content-type", "application/yaml; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="agent-${a.handle}.yaml"`);
    return stringifyYaml(spec);
  });

  // Export the whole workspace's agents as a team template (with reportsTo
  // resolved to handles so the hierarchy round-trips).
  app.get("/agents/team/export", { preHandler: requireWorkspace }, async (req, reply) => {
    const { workspaceId } = req.auth!;
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId!))
      .orderBy(desc(agents.createdAt));
    const team = await Promise.all(rows.map((a) => agentToSpec(a, workspaceId!)));
    reply.header("content-type", "application/yaml; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="team.yaml"`);
    return stringifyYaml({ version: 1, team });
  });

  // Import a single agent spec OR a team template ({ team: [...] }) from YAML.
  // Accepts the raw YAML body (text/yaml) or JSON { yaml: "..." }. Creates each
  // agent (skipping handles already in use), then wires reportsTo by handle.
  app.post("/agents/import", { preHandler: requireWorkspace }, async (req, reply) => {
    const { memberId, workspaceId } = req.auth!;
    let text = "";
    if (typeof req.body === "string") text = req.body;
    else if (req.body && typeof req.body === "object" && "yaml" in (req.body as Record<string, unknown>))
      text = String((req.body as { yaml: unknown }).yaml ?? "");
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (e) {
      return reply.code(400).send({ error: "invalid_yaml", detail: (e as Error).message });
    }
    const specsRaw = Array.isArray((doc as { team?: unknown })?.team)
      ? (doc as { team: unknown[] }).team
      : [doc];
    const parsed = z.array(AgentSpec).safeParse(specsRaw);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_spec", detail: parsed.error.issues });

    const created: Array<{ handle: string; id: string; memberId: string; botToken: string }> = [];
    const skipped: string[] = [];
    for (const spec of parsed.data) {
      const r = await createAgentFromSpec(spec, memberId!, workspaceId!);
      if ("error" in r) skipped.push(`${spec.handle}: ${r.error}`);
      else created.push({ handle: spec.handle, id: r.id, memberId: r.memberId, botToken: r.botToken });
    }

    // Wire reportsTo (by handle) now that every agent member exists. Resolve
    // handles across both the just-created agents and pre-existing ones.
    const wired: string[] = [];
    for (const spec of parsed.data) {
      if (!spec.reportsTo) continue;
      const childMember = await agentMemberByHandle(spec.handle, workspaceId!);
      const managerMember = await agentMemberByHandle(spec.reportsTo, workspaceId!);
      if (childMember && managerMember && childMember !== managerMember) {
        await db.update(members).set({ reportsTo: managerMember }).where(eq(members.id, childMember));
        wired.push(`${spec.handle}→${spec.reportsTo}`);
      }
    }
    return { created, skipped, wired };
  });
}

function mask(tok: string): string {
  if (!tok) return "";
  return `${tok.slice(0, 6)}…${tok.slice(-4)}`;
}

const COLORS = ["amber", "teal", "rose", "violet", "lime", "sky", "orange", "emerald"];
function pickColor(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

// ───── agent-as-code helpers ─────

// Build a secrets-free spec from an agent row, resolving its manager (reports_to)
// down to a handle so the org hierarchy round-trips through export/import.
async function agentToSpec(
  a: typeof agents.$inferSelect,
  workspaceId: string,
): Promise<AgentSpecT> {
  let reportsTo: string | null = null;
  const [self] = await db
    .select({ reportsTo: members.reportsTo })
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, a.id), eq(members.workspaceId, workspaceId)))
    .limit(1);
  if (self?.reportsTo) {
    const [mgr] = await db
      .select({ kind: members.kind, refId: members.refId })
      .from(members)
      .where(eq(members.id, self.reportsTo))
      .limit(1);
    if (mgr?.kind === "agent") {
      const [mgrAgent] = await db
        .select({ handle: agents.handle })
        .from(agents)
        .where(eq(agents.id, mgr.refId))
        .limit(1);
      reportsTo = mgrAgent?.handle ?? null;
    }
  }
  return {
    handle: a.handle,
    name: a.name,
    title: a.title || undefined,
    brief: a.brief || undefined,
    kind: a.kind as AgentSpecT["kind"],
    adapter: a.adapter as AgentSpecT["adapter"],
    model: a.model || undefined,
    scopes: a.scopes ?? [],
    heartbeatIntervalSec: a.heartbeatIntervalSec,
    avatarColor: a.avatarColor,
    ...(reportsTo ? { reportsTo } : {}),
  };
}

// Create an agent from a spec. Mirrors POST /agents but secrets-free: a fresh
// bot token is minted (returned so the operator can wire the runtime), and the
// agent stays "provisioning" until its socket/webhook registers. Idempotent on
// handle — an existing handle returns an error so the caller can skip it.
async function createAgentFromSpec(
  spec: AgentSpecT,
  creatorMemberId: string,
  workspaceId: string,
): Promise<{ id: string; memberId: string; botToken: string } | { error: string }> {
  const [existH] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.handle, spec.handle)))
    .limit(1);
  if (existH) return { error: "handle_in_use" };
  const agentId = id("a");
  const botToken = `cc_${rawToken(32)}`;
  const agentMemberId = id("m");
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    handle: spec.handle,
    name: spec.name,
    kind: spec.kind ?? "hermes",
    adapter: spec.adapter ?? "socket",
    configJson: {},
    model: spec.model ?? "",
    scopes: spec.scopes ?? ["channels.read", "channels.reply", "tasks.write"],
    status: "provisioning",
    title: spec.title ?? "",
    brief: spec.brief ?? "",
    botToken,
    heartbeatIntervalSec: spec.heartbeatIntervalSec ?? 180,
    callbackUrl: null,
    createdBy: creatorMemberId,
    avatarColor: spec.avatarColor || pickColor(spec.handle),
  });
  await db.insert(members).values({ id: agentMemberId, workspaceId, kind: "agent", refId: agentId });
  return { id: agentId, memberId: agentMemberId, botToken };
}

// Resolve an agent handle to its agent-member id within a workspace.
async function agentMemberByHandle(handle: string, workspaceId: string): Promise<string | null> {
  const [a] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.handle, handle)))
    .limit(1);
  if (!a) return null;
  const [m] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, a.id), eq(members.workspaceId, workspaceId)))
    .limit(1);
  return m?.id ?? null;
}
