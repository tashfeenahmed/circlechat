import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq, inArray, desc, isNull, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  conversationMembers,
  conversations,
  messages,
  members,
  users,
  agents,
  taskComments,
  tasks,
} from "../db/schema.js";
import { requireAuth, requireWorkspace, loadSession } from "../auth/session.js";
import { statObject, streamObject, deleteObject } from "../lib/storage.js";
import { workspaceMembers } from "../db/schema.js";
import { artifactByStorageKey } from "../lib/task-artifacts.js";

interface AttachmentRow {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

// The principal behind a /files/* request — either a human session or an agent
// bearer token — resolved to the member + workspace we authorize blob reads
// against. memberId is null for an agent whose member row is missing (treated
// as having no joined conversations).
declare module "fastify" {
  interface FastifyRequest {
    filePrincipal?: {
      kind: "user" | "agent";
      memberId: string | null;
      workspaceId: string;
    };
  }
}

// Accept either a human session cookie OR an agent bearer token, and resolve
// the principal's member + workspace so the handler can authorize the specific
// blob being requested (a valid token alone must NOT grant access to any key).
async function requireSessionOrAgent(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization ?? "";
  const bearer = header.replace(/^Bearer\s+/i, "");
  if (bearer) {
    const [a] = await db.select().from(agents).where(eq(agents.botToken, bearer)).limit(1);
    if (a) {
      const [m] = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.kind, "agent"), eq(members.refId, a.id)))
        .limit(1);
      req.filePrincipal = { kind: "agent", memberId: m?.id ?? null, workspaceId: a.workspaceId };
      return;
    }
  }
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
  const sid = cookies["cc_session"];
  if (sid) {
    const s = await loadSession(sid);
    if (s && s.workspaceId && s.memberId) {
      req.filePrincipal = { kind: "user", memberId: s.memberId, workspaceId: s.workspaceId };
      return;
    }
  }
  reply.code(401).send({ error: "unauthorized" });
}

// True if `key` is referenced by a message or task-comment the principal can
// actually see: a message in a conversation they've joined (or a public channel)
// within their own workspace, or a task-comment on a task in their workspace.
async function keyVisibleToPrincipal(
  key: string,
  principal: { memberId: string | null; workspaceId: string },
): Promise<boolean> {
  // Task artifacts live under t/<task_id>/… and are NOT referenced from any
  // attachments_json blob — they're their own first-class store. Authorize the
  // key by resolving it to its artifact row and checking the owning task is in
  // the principal's workspace (same workspace-scoped model as task-comment
  // attachments, below). A soft-deleted artifact's row won't resolve, so its
  // blob stops serving.
  if (key.startsWith("t/")) {
    const art = await artifactByStorageKey(key);
    if (!art) return false;
    if (art.workspaceId !== principal.workspaceId) return false;
    const [t] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, art.taskId), eq(tasks.workspaceId, principal.workspaceId)))
      .limit(1);
    return !!t;
  }

  const probe = JSON.stringify([{ key }]);

  // Messages that reference this key.
  const msgRows = await db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(dsql`${messages.attachmentsJson} @> ${probe}::jsonb` as never);
  if (msgRows.length) {
    const convIds = Array.from(new Set(msgRows.map((r) => r.conversationId)));
    const convRows = await db
      .select({
        id: conversations.id,
        workspaceId: conversations.workspaceId,
        kind: conversations.kind,
        isPrivate: conversations.isPrivate,
      })
      .from(conversations)
      .where(inArray(conversations.id, convIds));
    const joined = new Set<string>();
    if (principal.memberId) {
      const jm = await db
        .select({ conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.memberId, principal.memberId),
            inArray(conversationMembers.conversationId, convIds),
          ),
        );
      for (const r of jm) joined.add(r.conversationId);
    }
    for (const c of convRows) {
      if (c.workspaceId !== principal.workspaceId) continue;
      if (joined.has(c.id)) return true;
      if (c.kind === "channel" && !c.isPrivate) return true;
    }
  }

  // Task-comment attachments are workspace-scoped (same model as the board).
  const tcRows = await db
    .select({ taskId: taskComments.taskId })
    .from(taskComments)
    .where(dsql`${taskComments.attachmentsJson} @> ${probe}::jsonb` as never);
  if (tcRows.length) {
    const taskIds = Array.from(new Set(tcRows.map((r) => r.taskId)));
    const [t] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(inArray(tasks.id, taskIds), eq(tasks.workspaceId, principal.workspaceId)))
      .limit(1);
    if (t) return true;
  }

  return false;
}

// File serving: session cookie (web UI) OR agent bearer token (agent runtime).
export async function fileServeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireSessionOrAgent);

  app.get("/files/*", async (req, reply) => {
    const key = (req.params as { "*": string })["*"];
    if (!key) return reply.code(400).send({ error: "no_key" });
    // Authorize the specific blob against the principal's visible content —
    // a valid token is necessary but not sufficient. 404 (not 403) so we don't
    // confirm a key exists to a caller who can't see it.
    const principal = req.filePrincipal!;
    if (!(await keyVisibleToPrincipal(key, principal)))
      return reply.code(404).send({ error: "not_found" });
    const st = await statObject(key);
    if (!st || !st.isFile()) return reply.code(404).send({ error: "not_found" });
    const ct = guessContentType(key);
    reply.header("content-type", ct);
    reply.header("content-length", String(st.size));
    reply.header("cache-control", "private, max-age=60");
    // Display in the browser rather than force-downloading. Without this,
    // navigating to e.g. a text/markdown URL pops a Save dialog. The web
    // viewer's explicit Download button uses the <a download> attribute, which
    // overrides this, so "download" still works.
    const fname = (key.split("/").pop() || "file").replace(/[\r\n"]/g, "_");
    reply.header("content-disposition", `inline; filename="${fname}"`);
    return reply.send(streamObject(key));
  });
}

// Directory listing: every attachment in conversations the caller is part of.
// Does not copy data — just reads messages.attachments_json and stats the
// underlying file on disk so deletions surface as `exists: false`.
export async function fileDirectoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/files", async (req) => {
    const memberId = req.auth!.memberId!;
    const workspaceId = req.auth!.workspaceId!;

    const mc = await db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.memberId, memberId));
    const convIds = mc.map((r) => r.conversationId);

    const rows = convIds.length ? await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        memberId: messages.memberId,
        ts: messages.ts,
        attachmentsJson: messages.attachmentsJson,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, convIds),
          isNull(messages.deletedAt),
          // Gate jsonb_array_length on type-check — a single row with
          // attachments_json stored as anything other than a JSON array
          // (e.g. a double-encoded string) would otherwise throw and
          // blow up the whole /files listing for every caller.
          dsql`jsonb_typeof(${messages.attachmentsJson}) = 'array'` as never,
          dsql`jsonb_array_length(${messages.attachmentsJson}) > 0` as never,
        ),
      )
      .orderBy(desc(messages.ts))
      .limit(500) : [];

    const uniqueConvIds = Array.from(new Set(rows.map((r) => r.conversationId)));
    const convRows = await db
      .select({ id: conversations.id, kind: conversations.kind, name: conversations.name })
      .from(conversations)
      .where(inArray(conversations.id, uniqueConvIds));
    const convById = new Map(convRows.map((c) => [c.id, c]));

    const dmConvIds = convRows.filter((c) => c.kind === "dm").map((c) => c.id) as string[];
    const dmOtherByConv = new Map<string, string>();
    if (dmConvIds.length) {
      const dm = await db
        .select({
          conversationId: conversationMembers.conversationId,
          memberId: conversationMembers.memberId,
        })
        .from(conversationMembers)
        .where(inArray(conversationMembers.conversationId, dmConvIds));
      for (const cid of dmConvIds) {
        const these = dm.filter((r) => r.conversationId === cid);
        dmOtherByConv.set(cid, these.find((r) => r.memberId !== memberId)?.memberId ?? memberId);
      }
    }

    const authorIds = Array.from(new Set(rows.map((r) => r.memberId)));
    const dirRows = await db
      .select({ id: members.id, kind: members.kind, refId: members.refId })
      .from(members)
      .where(inArray(members.id, authorIds));
    const userRefs = dirRows.filter((d) => d.kind === "user").map((d) => d.refId);
    const agentRefs = dirRows.filter((d) => d.kind === "agent").map((d) => d.refId);
    const userRows = userRefs.length
      ? await db
          .select({ id: users.id, name: users.name, handle: users.handle })
          .from(users)
          .where(inArray(users.id, userRefs))
      : [];
    const agentRows = agentRefs.length
      ? await db
          .select({ id: agents.id, name: agents.name, handle: agents.handle })
          .from(agents)
          .where(inArray(agents.id, agentRefs))
      : [];
    const byUserId = new Map(userRows.map((u) => [u.id, u]));
    const byAgentId = new Map(agentRows.map((a) => [a.id, a]));
    const authorByMember = new Map(
      dirRows.map((d) => {
        const ref =
          d.kind === "user" ? byUserId.get(d.refId) : byAgentId.get(d.refId);
        return [d.id, ref ? { name: ref.name, handle: ref.handle, kind: d.kind } : null];
      }),
    );

    interface FileRow {
      key: string;
      name: string;
      contentType: string;
      size: number;
      url: string;
      exists: boolean;
      onDiskSize: number | null;
      // Source discriminator — either a chat message or a task comment.
      source: "message" | "task_comment";
      messageId: string | null;
      conversationId: string | null;
      conversationKind: string | null;
      conversationName: string | null;
      conversationOtherMemberId: string | null;
      // Task context (only populated when source === "task_comment").
      taskId: string | null;
      taskTitle: string | null;
      commentId: string | null;
      ts: string;
      author: { name: string; handle: string; kind: string } | null;
    }
    const expanded: FileRow[] = [];

    for (const r of rows) {
      const atts = (r.attachmentsJson as AttachmentRow[]) ?? [];
      const c = convById.get(r.conversationId);
      for (const a of atts) {
        const st = await statObject(a.key);
        expanded.push({
          key: a.key,
          name: a.name,
          contentType: a.contentType,
          size: a.size,
          url: a.url,
          exists: !!st,
          onDiskSize: st?.size ?? null,
          source: "message",
          messageId: r.id,
          conversationId: r.conversationId,
          conversationKind: c?.kind ?? "channel",
          conversationName: c?.name ?? null,
          conversationOtherMemberId:
            c?.kind === "dm" ? dmOtherByConv.get(r.conversationId) ?? memberId : null,
          taskId: null,
          taskTitle: null,
          commentId: null,
          ts: r.ts.toISOString(),
          author: authorByMember.get(r.memberId) ?? null,
        });
      }
    }

    // Task-comment attachments — workspace-scoped, not conversation-scoped,
    // so any member of the workspace can see them (same visibility model as
    // the board page itself).
    const taskRows = workspaceId
      ? await db
          .select({
            commentId: taskComments.id,
            taskId: taskComments.taskId,
            memberId: taskComments.memberId,
            ts: taskComments.ts,
            attachmentsJson: taskComments.attachmentsJson,
            taskTitle: tasks.title,
            taskWorkspaceId: tasks.workspaceId,
          })
          .from(taskComments)
          .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
          .where(
            and(
              eq(tasks.workspaceId, workspaceId),
              isNull(taskComments.deletedAt),
              dsql`jsonb_typeof(${taskComments.attachmentsJson}) = 'array'` as never,
              dsql`jsonb_array_length(${taskComments.attachmentsJson}) > 0` as never,
            ),
          )
          .orderBy(desc(taskComments.ts))
          .limit(500)
      : [];

    if (taskRows.length) {
      // Pull any authors we haven't already resolved from message rows.
      const newAuthorIds = Array.from(
        new Set(taskRows.map((r) => r.memberId).filter((id) => !authorByMember.has(id))),
      );
      if (newAuthorIds.length) {
        const nd = await db
          .select({ id: members.id, kind: members.kind, refId: members.refId })
          .from(members)
          .where(inArray(members.id, newAuthorIds));
        const nu = nd.filter((d) => d.kind === "user").map((d) => d.refId);
        const na = nd.filter((d) => d.kind === "agent").map((d) => d.refId);
        const nuR = nu.length
          ? await db.select({ id: users.id, name: users.name, handle: users.handle }).from(users).where(inArray(users.id, nu))
          : [];
        const naR = na.length
          ? await db.select({ id: agents.id, name: agents.name, handle: agents.handle }).from(agents).where(inArray(agents.id, na))
          : [];
        const nuM = new Map(nuR.map((u) => [u.id, u]));
        const naM = new Map(naR.map((a) => [a.id, a]));
        for (const d of nd) {
          const ref = d.kind === "user" ? nuM.get(d.refId) : naM.get(d.refId);
          authorByMember.set(
            d.id,
            ref ? { name: ref.name, handle: ref.handle, kind: d.kind } : null,
          );
        }
      }
      for (const r of taskRows) {
        const atts = (r.attachmentsJson as unknown as AttachmentRow[]) ?? [];
        for (const a of atts) {
          const st = await statObject(a.key);
          expanded.push({
            key: a.key,
            name: a.name,
            contentType: a.contentType,
            size: a.size,
            url: a.url,
            exists: !!st,
            onDiskSize: st?.size ?? null,
            source: "task_comment",
            messageId: null,
            conversationId: null,
            conversationKind: null,
            conversationName: null,
            conversationOtherMemberId: null,
            taskId: r.taskId,
            taskTitle: r.taskTitle,
            commentId: r.commentId,
            ts: r.ts.toISOString(),
            author: authorByMember.get(r.memberId) ?? null,
          });
        }
      }
    }

    // Combined output is sorted by freshness regardless of source.
    expanded.sort((a, b) => b.ts.localeCompare(a.ts));
    return { files: expanded };
  });

  // Delete an attachment. The key identifies the file; we find the message OR
  // task-comment that references it (scoped to the caller's workspace), check
  // the caller is the author or a workspace admin, strip the entry from that
  // row's attachments_json, and unlink the blob from storage once no row in
  // the workspace still references it.
  //
  // Body: { key, source: "message"|"task_comment", id } where id is the
  // messageId or commentId. We re-derive ownership from the DB — the client
  // can't authorize itself by claiming a different author.
  app.post("/files/delete", async (req, reply) => {
    const memberId = req.auth!.memberId!;
    const userId = req.auth!.userId;
    const workspaceId = req.auth!.workspaceId!;
    const Body = z.object({
      key: z.string().min(1),
      source: z.enum(["message", "task_comment"]),
      id: z.string().min(1),
    });
    const body = Body.parse(req.body);

    // Is the caller a workspace admin? (Admins can delete anyone's file.)
    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    const isAdmin = wm?.role === "admin";

    if (body.source === "message") {
      const [m] = await db.select().from(messages).where(eq(messages.id, body.id)).limit(1);
      if (!m) return reply.code(404).send({ error: "not_found" });
      // Scope: the message's conversation must be in the caller's workspace.
      const [conv] = await db
        .select({ workspaceId: conversations.workspaceId })
        .from(conversations)
        .where(eq(conversations.id, m.conversationId))
        .limit(1);
      if (!conv || conv.workspaceId !== workspaceId)
        return reply.code(404).send({ error: "not_found" });
      if (m.memberId !== memberId && !isAdmin)
        return reply.code(403).send({ error: "not_author" });

      const before = (m.attachmentsJson as AttachmentRow[]) ?? [];
      if (!before.some((a) => a.key === body.key))
        return reply.code(404).send({ error: "attachment_not_found" });
      const after = before.filter((a) => a.key !== body.key);
      await db.update(messages).set({ attachmentsJson: after }).where(eq(messages.id, m.id));
    } else {
      const [c] = await db.select().from(taskComments).where(eq(taskComments.id, body.id)).limit(1);
      if (!c) return reply.code(404).send({ error: "not_found" });
      const [t] = await db
        .select({ workspaceId: tasks.workspaceId })
        .from(tasks)
        .where(eq(tasks.id, c.taskId))
        .limit(1);
      if (!t || t.workspaceId !== workspaceId)
        return reply.code(404).send({ error: "not_found" });
      if (c.memberId !== memberId && !isAdmin)
        return reply.code(403).send({ error: "not_author" });

      const before = (c.attachmentsJson as unknown as AttachmentRow[]) ?? [];
      if (!before.some((a) => a.key === body.key))
        return reply.code(404).send({ error: "attachment_not_found" });
      const after = before.filter((a) => a.key !== body.key);
      await db
        .update(taskComments)
        .set({ attachmentsJson: after as never })
        .where(eq(taskComments.id, c.id));
    }

    // Only unlink the underlying blob if nothing else still references this
    // key — the same uploaded file could (in principle) be attached twice.
    const stillUsed = await keyStillReferenced(body.key);
    if (!stillUsed) await deleteObject(body.key);

    return { ok: true, blobDeleted: !stillUsed };
  });
}

// True if any message or task-comment row still references this storage key in
// its attachments_json. Uses a jsonb containment check on each table.
async function keyStillReferenced(key: string): Promise<boolean> {
  const probe = JSON.stringify([{ key }]);
  const [msg] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(dsql`${messages.attachmentsJson} @> ${probe}::jsonb` as never)
    .limit(1);
  if (msg) return true;
  const [tc] = await db
    .select({ id: taskComments.id })
    .from(taskComments)
    .where(dsql`${taskComments.attachmentsJson} @> ${probe}::jsonb` as never)
    .limit(1);
  return !!tc;
}

function guessContentType(key: string): string {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json",
    csv: "text/csv",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}
