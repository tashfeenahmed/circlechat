import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, asc, desc, lt, ilike, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  members,
  conversations,
  conversationMembers,
  messages,
  reactions,
  users,
} from "../db/schema.js";
import { putObject, publicUrl } from "../lib/storage.js";
import { id as makeId } from "../lib/ids.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { publishToConversation } from "../lib/events.js";
import { checkReplyBody } from "../agents/reply-guard.js";
import { checkRecentDuplicate } from "../agents/dedupe.js";
import { sanitizeAttachments } from "../agents/executor.js";
import {
  STATUSES,
  listTasks,
  getTaskDetail,
  createTask,
  updateTask,
  deleteTask,
  addAssignee,
  removeAssignee,
  setLabels,
  addLink,
  removeLink,
  addComment,
} from "../lib/tasks-core.js";
import {
  extractMentionHandles,
  resolveHandlesToMemberIds,
  fireMentionTriggers,
} from "../agents/mention-triggers.js";

// Auth: Bearer <agent.botToken>  → resolves `req.agentCtx` with agentId + memberId.
// Anything hitting these endpoints is a trusted agent process and can see messages
// in conversations the agent is a member of (plus any other public channel).
declare module "fastify" {
  interface FastifyRequest {
    agentCtx?: {
      agentId: string;
      memberId: string;
      handle: string;
    };
  }
}

async function requireAgentToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) {
    reply.code(401).send({ error: "missing_bearer" });
    return;
  }
  const [a] = await db.select().from(agents).where(eq(agents.botToken, token)).limit(1);
  if (!a) {
    reply.code(401).send({ error: "invalid_token" });
    return;
  }
  const [m] = await db
    .select()
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, a.id)))
    .limit(1);
  if (!m) {
    reply.code(500).send({ error: "agent_member_missing" });
    return;
  }
  req.agentCtx = { agentId: a.id, memberId: m.id, handle: a.handle };
}

async function agentVisibleConversations(memberId: string): Promise<string[]> {
  const rows = await db
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.memberId, memberId));
  const joined = rows.map((r) => r.id);
  const pubs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.kind, "channel"), eq(conversations.isPrivate, false)));
  const set = new Set([...joined, ...pubs.map((p) => p.id)]);
  return Array.from(set);
}

function makeResolver(
  memberDir: Record<string, { handle: string; name: string; kind: string }>,
  rxMap: Map<string, Array<{ emoji: string; memberId: string; memberHandle: string }>>,
) {
  return (m: typeof messages.$inferSelect) => ({
    id: m.id,
    conversationId: m.conversationId,
    memberId: m.memberId,
    memberHandle: memberDir[m.memberId]?.handle ?? "unknown",
    memberName: memberDir[m.memberId]?.name ?? "unknown",
    memberKind: memberDir[m.memberId]?.kind ?? "unknown",
    parentId: m.parentId,
    bodyMd: m.bodyMd,
    ts: m.ts.toISOString(),
    reactions: rxMap.get(m.id) ?? [],
    attachments: m.attachmentsJson ?? [],
  });
}

async function reactionsFor(
  msgIds: string[],
  memberDir: Record<string, { handle: string; name: string; kind: string }>,
): Promise<Map<string, Array<{ emoji: string; memberId: string; memberHandle: string }>>> {
  const map = new Map<string, Array<{ emoji: string; memberId: string; memberHandle: string }>>();
  if (!msgIds.length) return map;
  const rows = await db.select().from(reactions).where(inArray(reactions.messageId, msgIds));
  // Fill memberDir for any reactor we haven't resolved.
  const unknownReactors = rows.map((r) => r.memberId).filter((mid) => !memberDir[mid]);
  if (unknownReactors.length) {
    const extra = await resolveMembers(unknownReactors);
    Object.assign(memberDir, extra);
  }
  for (const r of rows) {
    const arr = map.get(r.messageId) ?? [];
    arr.push({
      emoji: r.emoji,
      memberId: r.memberId,
      memberHandle: memberDir[r.memberId]?.handle ?? "unknown",
    });
    map.set(r.messageId, arr);
  }
  return map;
}

async function resolveMembers(
  memberIds: string[],
): Promise<Record<string, { handle: string; name: string; kind: string }>> {
  if (!memberIds.length) return {};
  const dedup = Array.from(new Set(memberIds));
  const mrows = await db.select().from(members).where(inArray(members.id, dedup));
  const userRefs = mrows.filter((m) => m.kind === "user").map((m) => m.refId);
  const agentRefs = mrows.filter((m) => m.kind === "agent").map((m) => m.refId);
  const uRows = userRefs.length ? await db.select().from(users).where(inArray(users.id, userRefs)) : [];
  const aRows = agentRefs.length ? await db.select().from(agents).where(inArray(agents.id, agentRefs)) : [];
  const uMap = new Map(uRows.map((u) => [u.id, u]));
  const aMap = new Map(aRows.map((a) => [a.id, a]));
  const out: Record<string, { handle: string; name: string; kind: string }> = {};
  for (const m of mrows) {
    if (m.kind === "user") {
      const u = uMap.get(m.refId);
      if (u) out[m.id] = { handle: u.handle, name: u.name, kind: "user" };
    } else {
      const ag = aMap.get(m.refId);
      if (ag) out[m.id] = { handle: ag.handle, name: ag.name, kind: "agent" };
    }
  }
  return out;
}

export default async function agentApiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAgentToken);

  // GET /agent-api/me — who am I?
  app.get("/agent-api/me", async (req) => {
    return req.agentCtx;
  });

  // POST /agent-api/uploads — multipart file upload. Returns an attachment
  // descriptor {key, name, contentType, size, url} that the agent can then
  // attach to a subsequent post_message action.
  app.post("/agent-api/uploads", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "no_file" });
    const buf = await data.toBuffer();
    const safeName = data.filename.replace(/[^a-z0-9._-]/gi, "_");
    const key = `u/${makeId("f").slice(2)}/${safeName}`;
    await putObject(key, buf);
    return {
      key,
      name: data.filename,
      contentType: data.mimetype,
      size: buf.length,
      url: publicUrl(key),
    };
  });

  // POST /agent-api/post_message — first-class write endpoint (MCP uses it).
  // The agent must already be a member of the conversation. Mentions are
  // resolved server-side from handles in the body, matching the human path.
  app.post("/agent-api/post_message", async (req, reply) => {
    const body = z
      .object({
        conversationId: z.string().min(1),
        bodyMd: z.string().min(1).max(20_000),
        replyTo: z.string().optional().nullable(),
        attachments: z
          .array(
            z.object({
              key: z.string(),
              name: z.string(),
              contentType: z.string(),
              size: z.number(),
              url: z.string(),
            }),
          )
          .optional(),
      })
      .parse(req.body);
    const { memberId } = req.agentCtx!;

    const [mm] = await db
      .select({ id: conversationMembers.memberId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, body.conversationId),
          eq(conversationMembers.memberId, memberId),
        ),
      )
      .limit(1);
    if (!mm) return reply.code(403).send({ error: "not_in_conversation" });

    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    const guard = checkReplyBody(body.bodyMd, { hasAttachments });
    if (!guard.ok) {
      req.log.warn(
        { agentId: req.agentCtx!.agentId, reason: guard.reason },
        "reply_guard_rejected",
      );
      return reply.code(422).send({ error: "reply_rejected", reason: guard.reason });
    }
    const dup = await checkRecentDuplicate(body.conversationId, guard.bodyMd);
    if (!dup.ok) {
      req.log.warn(
        {
          agentId: req.agentCtx!.agentId,
          conversationId: body.conversationId,
          againstId: dup.againstId,
          score: dup.score,
        },
        "duplicate_of_recent",
      );
      return reply
        .code(422)
        .send({ error: "reply_rejected", reason: "duplicate_of_recent" });
    }

    // Resolve mentions so downstream triggers (agent→agent @) and the
    // unread/mention counts on the sidebar both work.
    const [authorMember] = await db
      .select({ workspaceId: members.workspaceId })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    const workspaceId = authorMember?.workspaceId ?? "";
    const handles = extractMentionHandles(guard.bodyMd);
    const isBroadcast = handles.some((h) => h === "everyone" || h === "channel");
    const directMentionIds = await resolveHandlesToMemberIds(handles, workspaceId);
    let broadcastIds: string[] = [];
    if (isBroadcast) {
      const all = await db
        .select({ memberId: conversationMembers.memberId })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, body.conversationId));
      broadcastIds = all.map((r) => r.memberId).filter((m) => m !== memberId);
    }
    const resolvedMentionIds = Array.from(
      new Set([...directMentionIds, ...broadcastIds]),
    );

    const id = makeId("m");
    const ts = new Date();
    // Enforce the same attachment shape agent actions do: keys must point at
    // storage the server wrote (u/<rand>/<name>), so agents can't hand-roll a
    // descriptor pointing at an arbitrary external URL (e.g. cataas.com/cat)
    // and have it render in chat as an image. The old path trusted whatever
    // the agent sent, producing attachments whose content changed on every
    // view. Bad descriptors are dropped silently and logged in traces.
    const safeAttachments = sanitizeAttachments(body.attachments);
    await db.insert(messages).values({
      id,
      conversationId: body.conversationId,
      memberId,
      parentId: body.replyTo ?? null,
      bodyMd: guard.bodyMd,
      attachmentsJson: safeAttachments,
      mentions: resolvedMentionIds,
      ts,
    });
    await publishToConversation(body.conversationId, {
      type: "message.new",
      conversationId: body.conversationId,
      message: {
        id,
        conversationId: body.conversationId,
        memberId,
        parentId: body.replyTo ?? null,
        bodyMd: guard.bodyMd,
        attachmentsJson: safeAttachments,
        mentions: resolvedMentionIds,
        ts: ts.toISOString(),
        reactions: [],
        replyCount: 0,
      },
    });

    // Fire downstream triggers: agents mentioned (including @everyone),
    // thread participants, etc. Agent-to-agent mentions go through the
    // same path human-to-agent mentions do.
    if (workspaceId) {
      fireMentionTriggers({
        authorMemberId: memberId,
        conversationId: body.conversationId,
        messageId: id,
        bodyMd: guard.bodyMd,
        parentId: body.replyTo ?? null,
        workspaceId,
        resolvedMentionIds,
        directMentionIds,
        isBroadcast,
      }).catch((e) =>
        req.log.warn({ err: (e as Error).message }, "agent_mention_triggers"),
      );
    }

    return { id };
  });

  // POST /agent-api/react — toggle a reaction on a message.
  app.post("/agent-api/react", async (req, reply) => {
    const body = z
      .object({
        messageId: z.string().min(1),
        emoji: z.string().min(1).max(32),
      })
      .parse(req.body);
    const { memberId } = req.agentCtx!;

    const [m] = await db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    if (!m) return reply.code(404).send({ error: "message_not_found" });

    const [mm] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, m.conversationId),
          eq(conversationMembers.memberId, memberId),
        ),
      )
      .limit(1);
    if (!mm) return reply.code(403).send({ error: "not_in_conversation" });

    await db
      .insert(reactions)
      .values({ messageId: body.messageId, memberId, emoji: body.emoji })
      .onConflictDoNothing();
    await publishToConversation(m.conversationId, {
      type: "reaction.toggled",
      conversationId: m.conversationId,
      messageId: body.messageId,
      memberId,
      emoji: body.emoji,
      added: true,
    });
    return { ok: true };
  });

  // POST /agent-api/start_dm — open (or fetch) a 1:1 conversation with another
  // member of the agent's workspace. Deterministic id so repeated calls are
  // idempotent.
  app.post("/agent-api/start_dm", async (req, reply) => {
    const body = z.object({ otherMemberId: z.string().min(1) }).parse(req.body);
    const { memberId } = req.agentCtx!;

    // Both members must be in the same workspace. Look up agent's member row
    // to find workspaceId, then verify the other member is co-located.
    const [me] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
    if (!me) return reply.code(404).send({ error: "self_not_found" });
    const [other] = await db
      .select()
      .from(members)
      .where(and(eq(members.id, body.otherMemberId), eq(members.workspaceId, me.workspaceId)))
      .limit(1);
    if (!other) return reply.code(403).send({ error: "other_not_in_workspace" });

    const sorted = [memberId, body.otherMemberId].sort().join(":");
    const convId = `c_dm_${createHash("sha1").update(sorted).digest("hex").slice(0, 24)}`;

    await db
      .insert(conversations)
      .values({ id: convId, workspaceId: me.workspaceId, kind: "dm", createdBy: memberId })
      .onConflictDoNothing();
    await db
      .insert(conversationMembers)
      .values(
        body.otherMemberId === memberId
          ? [{ conversationId: convId, memberId, role: "member" as const }]
          : [
              { conversationId: convId, memberId, role: "member" as const },
              { conversationId: convId, memberId: body.otherMemberId, role: "member" as const },
            ],
      )
      .onConflictDoNothing();
    return { conversationId: convId };
  });

  // GET /agent-api/conversations — list all convs I can see
  app.get("/agent-api/conversations", async (req) => {
    const convIds = await agentVisibleConversations(req.agentCtx!.memberId);
    if (!convIds.length) return { conversations: [] };
    const rows = await db.select().from(conversations).where(inArray(conversations.id, convIds));
    return {
      conversations: rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        topic: c.topic,
        isPrivate: c.isPrivate,
      })),
    };
  });

  // GET /agent-api/messages?conversationId=...&parentId=...&before=ISO&limit=50
  // Lists messages in a conversation, optionally filtered to a thread or a time window.
  app.get("/agent-api/messages", async (req, reply) => {
    const q = req.query as {
      conversationId?: string;
      parentId?: string;
      before?: string;
      limit?: string;
    };
    if (!q.conversationId) return reply.code(400).send({ error: "conversationId_required" });
    const convIds = await agentVisibleConversations(req.agentCtx!.memberId);
    if (!convIds.includes(q.conversationId))
      return reply.code(403).send({ error: "not_visible" });

    const where = [eq(messages.conversationId, q.conversationId), isNull(messages.deletedAt)];
    if (q.parentId) where.push(eq(messages.parentId, q.parentId));
    if (q.before) where.push(lt(messages.ts, new Date(q.before)));
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));

    const rows = await db
      .select()
      .from(messages)
      .where(and(...where))
      .orderBy(desc(messages.ts))
      .limit(limit);

    const dir = await resolveMembers(rows.map((r) => r.memberId));
    const rx = await reactionsFor(rows.map((r) => r.id), dir);
    const resolver = makeResolver(dir, rx);
    return { messages: rows.reverse().map(resolver) };
  });

  // GET /agent-api/thread?messageId=...   (root + all replies)
  app.get("/agent-api/thread", async (req, reply) => {
    const q = req.query as { messageId?: string };
    if (!q.messageId) return reply.code(400).send({ error: "messageId_required" });
    const [trig] = await db.select().from(messages).where(eq(messages.id, q.messageId)).limit(1);
    if (!trig) return reply.code(404).send({ error: "not_found" });
    const convIds = await agentVisibleConversations(req.agentCtx!.memberId);
    if (!convIds.includes(trig.conversationId))
      return reply.code(403).send({ error: "not_visible" });
    const rootId = trig.parentId ?? trig.id;
    const [root] = await db.select().from(messages).where(eq(messages.id, rootId)).limit(1);
    const replies = await db
      .select()
      .from(messages)
      .where(and(eq(messages.parentId, rootId), isNull(messages.deletedAt)))
      .orderBy(asc(messages.ts));
    const chain = [root, ...replies].filter(Boolean) as typeof replies;
    const dir = await resolveMembers(chain.map((m) => m.memberId));
    const rx = await reactionsFor(chain.map((m) => m.id), dir);
    const resolver = makeResolver(dir, rx);
    return { rootMessageId: rootId, messages: chain.map(resolver) };
  });

  // GET /agent-api/search?q=...&conversationId=...&limit=20
  // Case-insensitive substring search across visible conversations.
  app.get("/agent-api/search", async (req, reply) => {
    const q = req.query as { q?: string; conversationId?: string; limit?: string };
    if (!q.q || q.q.length < 2) return reply.code(400).send({ error: "q_too_short" });
    const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20)));

    const convIds = q.conversationId
      ? [q.conversationId]
      : await agentVisibleConversations(req.agentCtx!.memberId);
    if (!convIds.length) return { matches: [] };

    const rows = await db
      .select()
      .from(messages)
      .where(and(inArray(messages.conversationId, convIds), ilike(messages.bodyMd, `%${q.q}%`), isNull(messages.deletedAt)))
      .orderBy(desc(messages.ts))
      .limit(limit);

    const dir = await resolveMembers(rows.map((r) => r.memberId));
    const rx = await reactionsFor(rows.map((r) => r.id), dir);
    const resolver = makeResolver(dir, rx);
    return { matches: rows.map(resolver) };
  });

  // GET /agent-api/members — full workspace directory (for @mention construction)
  app.get("/agent-api/members", async () => {
    const u = await db.select().from(users);
    const a = await db.select().from(agents);
    const uMembers = await db.select().from(members).where(eq(members.kind, "user"));
    const aMembers = await db.select().from(members).where(eq(members.kind, "agent"));
    const uM = new Map(uMembers.map((m) => [m.refId, m.id]));
    const aM = new Map(aMembers.map((m) => [m.refId, m.id]));
    return {
      humans: u.map((x) => ({ memberId: uM.get(x.id), handle: x.handle, name: x.name })),
      agents: a.map((x) => ({ memberId: aM.get(x.id), handle: x.handle, name: x.name })),
    };
  });

  // ─── Tasks / Boards ─────────────────────────────────────────────────
  const TASK_ERR: Record<string, number> = {
    wrong_workspace: 403,
    not_found: 404,
    not_author: 403,
    comment_not_found: 404,
    invalid_parent: 400,
    invalid_assignee: 400,
    cannot_link_to_self: 400,
    linked_not_found: 400,
  };
  function taskSend(
    reply: import("fastify").FastifyReply,
    result: { error?: string; [k: string]: unknown },
  ) {
    if (result.error) return reply.code(TASK_ERR[result.error] ?? 400).send({ error: result.error });
    return result;
  }
  async function agentWorkspaceId(agentId: string): Promise<string | null> {
    const [a] = await db
      .select({ workspaceId: agents.workspaceId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return a?.workspaceId ?? null;
  }

  app.get("/agent-api/tasks", async (req, reply) => {
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return await listTasks(ws);
  });
  app.get("/agent-api/tasks/:id", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(reply, await getTaskDetail(taskId, ws));
  });
  app.post("/agent-api/tasks", async (req, reply) => {
    const body = z
      .object({
        title: z.string().min(1).max(200),
        bodyMd: z.string().max(20000).optional(),
        status: z.enum(STATUSES).optional(),
        parentId: z.string().optional(),
        conversationId: z.string().nullable().optional(),
        sourceMessageId: z.string().optional(),
        assignees: z.array(z.string()).optional(),
        labels: z.array(z.string().max(40)).optional(),
        dueAt: z.string().datetime().nullable().optional(),
        position: z.number().optional(),
      })
      .parse(req.body);
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(reply, await createTask(body, req.agentCtx!.memberId, ws));
  });
  app.patch("/agent-api/tasks/:id", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        bodyMd: z.string().max(20000).optional(),
        status: z.enum(STATUSES).optional(),
        position: z.number().optional(),
        dueAt: z.string().datetime().nullable().optional(),
        progress: z.number().int().min(0).max(100).optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(reply, await updateTask(taskId, body, req.agentCtx!.memberId, ws));
  });
  app.delete("/agent-api/tasks/:id", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(reply, await deleteTask(taskId, ws));
  });
  app.post("/agent-api/tasks/:id/assignees", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = z.object({ memberId: z.string().min(1) }).parse(req.body);
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(reply, await addAssignee(taskId, body.memberId, req.agentCtx!.memberId, ws));
  });
  app.delete("/agent-api/tasks/:id/assignees/:memberId", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const target = (req.params as { memberId: string }).memberId;
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(reply, await removeAssignee(taskId, target, req.agentCtx!.memberId, ws));
  });
  app.put("/agent-api/tasks/:id/labels", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = z.object({ labels: z.array(z.string().max(40)) }).parse(req.body);
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(reply, await setLabels(taskId, body.labels, req.agentCtx!.memberId, ws));
  });
  app.post("/agent-api/tasks/:id/links", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = z
      .object({
        linkedTaskId: z.string().min(1),
        kind: z.enum(["relates", "blocks", "duplicate"]).optional(),
      })
      .parse(req.body);
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(
      reply,
      await addLink(taskId, body.linkedTaskId, body.kind ?? "relates", req.agentCtx!.memberId, ws),
    );
  });
  app.delete("/agent-api/tasks/:id/links/:linkId", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const linkId = (req.params as { linkId: string }).linkId;
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    return taskSend(reply, await removeLink(taskId, linkId, req.agentCtx!.memberId, ws));
  });
  app.post("/agent-api/tasks/:id/comments", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = z
      .object({
        bodyMd: z.string().min(1).max(20000),
        mentions: z.array(z.string()).optional(),
        // Parity with chat post_message: agents can attach files to a task
        // comment by uploading first via /agent-api/uploads and passing the
        // returned descriptor here. Without this, agents had to round-trip
        // through the share_to_task action just to attach a single file.
        attachments: z
          .array(
            z.object({
              key: z.string(),
              name: z.string(),
              contentType: z.string(),
              size: z.number(),
              url: z.string(),
            }),
          )
          .optional(),
      })
      .parse(req.body);
    const ws = await agentWorkspaceId(req.agentCtx!.agentId);
    if (!ws) return reply.code(500).send({ error: "agent_workspace_missing" });
    const safeAttachments = sanitizeAttachments(body.attachments);
    const guard = checkReplyBody(body.bodyMd, { hasAttachments: safeAttachments.length > 0 });
    if (!guard.ok) {
      req.log.warn(
        { agentId: req.agentCtx!.agentId, taskId, reason: guard.reason },
        "task_comment_guard_rejected",
      );
      return reply.code(422).send({ error: "comment_rejected", reason: guard.reason });
    }
    return taskSend(
      reply,
      await addComment(
        taskId,
        guard.bodyMd,
        body.mentions ?? [],
        req.agentCtx!.memberId,
        ws,
        safeAttachments,
      ),
    );
  });

  // Browser proxy: shell out to the host's `agent-browser` CLI so agents can
  // read live pages / fill forms / snapshot via their existing terminal skill.
  // We don't expose the raw CLI inside each container — one Chromium daemon
  // lives on the host (`/usr/bin/chromium`) and `agent-browser` talks to it.
  // The endpoint is intentionally thin: it forwards the `cmd` + `args` array
  // straight to the CLI and returns stdout/stderr/exitCode verbatim.
  app.post("/agent-api/browser", async (req, reply) => {
    const body = z
      .object({
        cmd: z
          .string()
          .regex(/^[a-z][a-z0-9_-]*( [a-z][a-z0-9_-]*){0,2}$/i, "bad_command"),
        args: z.array(z.string().max(2000)).max(20).optional(),
        stdin: z.string().max(20000).optional(),
      })
      .parse(req.body);
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.env.AGENT_BROWSER_BIN ?? "agent-browser",
      [...body.cmd.split(" "), ...(body.args ?? [])],
      {
        env: { ...process.env, BROWSER_PATH: process.env.CHROMIUM_BIN ?? "/usr/bin/chromium" },
        timeout: 45_000,
      },
    );
    if (body.stdin) {
      child.stdin.end(body.stdin);
    } else {
      child.stdin.end();
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const code: number = await new Promise((resolve) => {
      child.on("close", (c) => resolve(c ?? -1));
      child.on("error", () => resolve(-1));
    });
    return reply.send({
      exitCode: code,
      stdout: stdout.slice(0, 32_000),
      stderr: stderr.slice(0, 4000),
    });
  });
}
