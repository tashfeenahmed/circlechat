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
  heartbeatIntervalSec: z.number().int().min(5).max(3600).optional(),
  channelIds: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const PatchBody = z.object({
  name: z.string().optional(),
  title: z.string().max(160).optional(),
  brief: z.string().max(2000).optional(),
  scopes: z.array(z.string()).optional(),
  callbackUrl: z.string().url().optional(),
  heartbeatIntervalSec: z.number().int().min(5).max(3600).optional(),
  model: z.string().max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const RegisterBody = z.object({ callbackUrl: z.string().url() });

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
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
