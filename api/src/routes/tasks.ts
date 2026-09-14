import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks, taskAssignees, boardStages } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { SPECTATOR_DONE_WINDOW_MS } from "../lib/retention.js";
import { spectatorTaskView } from "../lib/agent-view.js";
import { scrubPublicBody, spectatorTaskText } from "../lib/public-text.js";
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
  deleteComment,
  hydrateTasks,
  isSystemNotice,
  loadTask,
} from "../lib/tasks-core.js";

const CreateBody = z.object({
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
});

const UpdateBody = z.object({
  title: z.string().min(1).max(200).optional(),
  bodyMd: z.string().max(20000).optional(),
  status: z.enum(STATUSES).optional(),
  position: z.number().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  archived: z.boolean().optional(),
});

const AssignBody = z.object({ memberId: z.string().min(1) });
const LabelsBody = z.object({ labels: z.array(z.string().max(40)) });
const LinkBody = z.object({
  linkedTaskId: z.string().min(1),
  kind: z.enum(["relates", "blocks", "duplicate"]).optional(),
  // Optional branch condition for a `blocks` edge: the source must complete
  // carrying a label equal to this value for the edge to auto-start the target.
  condition: z.string().max(60).optional(),
});
const CommentBody = z.object({
  bodyMd: z.string().min(1).max(20000),
  mentions: z.array(z.string()).optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
});

const ERR_CODE: Record<string, number> = {
  wrong_workspace: 403,
  not_found: 404,
  not_author: 403,
  comment_not_found: 404,
  invalid_parent: 400,
  invalid_assignee: 400,
  cannot_link_to_self: 400,
  linked_not_found: 400,
};

function send(reply: import("fastify").FastifyReply, result: { error?: string; [k: string]: unknown }) {
  if (result.error) {
    const { error, ...details } = result;
    return reply.code(ERR_CODE[error] ?? 400).send({ error, ...details });
  }
  return result;
}

export default async function tasksRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  // Paginated: `?limit=` (default 100, max 500) and `?cursor=` from the
  // previous page's `nextCursor`. The board fetches every page, so it still
  // renders the whole workspace — it just no longer arrives as one 73 KB blob.
  app.get("/tasks", async (req) => {
    // Spectators (the public fishbowl identity) get the same Done window the
    // board UI enforces for everyone — they have no "show older" toggle, and
    // shipping months of finished cards to an anonymous visitor grew the
    // payload without bound for no benefit.
    const q = req.query as { limit?: unknown; cursor?: unknown };
    const r = await listTasks(req.auth!.workspaceId!, {
      limit: q.limit,
      cursor: q.cursor,
      doneWindowMs: req.spectator ? SPECTATOR_DONE_WINDOW_MS : null,
    });
    if (!req.spectator) return r;
    // `spectatorTaskView` drops the judge's rationale; `spectatorTaskText`
    // cleans the card's own title and body, which until now shipped raw —
    // "/workspace/backend/server.js" and "blocked on VERCEL_TOKEN" were both
    // live in this response. See lib/public-text.ts.
    return { ...r, tasks: r.tasks.map(spectatorTaskView).map(spectatorTaskText) };
  });

  app.post("/tasks", async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const r = await createTask(body, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.get("/tasks/:id", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const r = await getTaskDetail(taskId, req.auth!.workspaceId!);
    if (!r.error && req.spectator) {
      const detail = r as {
        task?: Record<string, unknown>;
        subtasks?: Array<Record<string, unknown>>;
        links?: Array<{ linked?: Record<string, unknown> | null }>;
        comments?: Array<{ bodyMd: string }>;
      };
      const publicTask = (t: Record<string, unknown>) => spectatorTaskText(spectatorTaskView(t));
      if (detail.task) detail.task = publicTask(detail.task);
      if (Array.isArray(detail.subtasks)) detail.subtasks = detail.subtasks.map(publicTask);
      // A linked card is a whole task row, title and body included — the same
      // text, reached by a different field.
      if (Array.isArray(detail.links)) {
        detail.links = detail.links.map((l) =>
          l && l.linked ? { ...l, linked: publicTask(l.linked) } : l,
        );
      }
      // System notices (the verification-hold comment) are addressed to
      // whoever runs the board, not to a visitor — see lib/tasks-core.ts.
      if (Array.isArray(detail.comments)) {
        detail.comments = detail.comments
          .filter((c) => !isSystemNotice(c.bodyMd))
          // Historical comment bodies predate the write-side guard and still
          // carry credentials, digests, ids and pasted diffs — scrub on read.
          .map((c) => ({ ...c, bodyMd: scrubPublicBody(c.bodyMd) }));
      }
    }
    return send(reply, r);
  });

  app.patch("/tasks/:id", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = UpdateBody.parse(req.body);
    const r = await updateTask(taskId, body, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.post("/tasks/:id/advance", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const task = await loadTask(taskId);
    if (!task || task.workspaceId !== req.auth!.workspaceId!) return reply.code(404).send({ error: "not_found" });
    const [stage] = await db.select({ nextStage: boardStages.nextStage }).from(boardStages)
      .where(and(eq(boardStages.workspaceId, req.auth!.workspaceId!), eq(boardStages.stage, task.status))).limit(1);
    const next = stage?.nextStage ?? ({ backlog: "in_progress", in_progress: "review", blocked: "in_progress", review: "done", done: null } as Record<string, string | null>)[task.status];
    if (!next || !STATUSES.includes(next as (typeof STATUSES)[number])) return reply.code(409).send({ error: "no_next_stage" });
    const result = await updateTask(taskId, { status: next as (typeof STATUSES)[number] }, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, result);
  });

  app.delete("/tasks/:id", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const r = await deleteTask(taskId, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.post("/tasks/:id/assignees", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = AssignBody.parse(req.body);
    const r = await addAssignee(taskId, body.memberId, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.delete("/tasks/:id/assignees/:memberId", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const target = (req.params as { memberId: string }).memberId;
    const r = await removeAssignee(taskId, target, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.put("/tasks/:id/labels", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = LabelsBody.parse(req.body);
    const r = await setLabels(taskId, body.labels, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.post("/tasks/:id/links", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = LinkBody.parse(req.body);
    const r = await addLink(
      taskId,
      body.linkedTaskId,
      body.kind ?? "relates",
      req.auth!.memberId!,
      req.auth!.workspaceId!,
      body.condition ?? null,
    );
    return send(reply, r);
  });

  app.delete("/tasks/:id/links/:linkId", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const linkId = (req.params as { linkId: string }).linkId;
    const r = await removeLink(taskId, linkId, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.post("/tasks/:id/comments", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = CommentBody.parse(req.body);
    const r = await addComment(
      taskId,
      body.bodyMd,
      body.mentions ?? [],
      req.auth!.memberId!,
      req.auth!.workspaceId!,
      body.attachments ?? [],
    );
    return send(reply, r);
  });

  app.delete("/tasks/:id/comments/:commentId", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const commentId = (req.params as { commentId: string }).commentId;
    const r = await deleteComment(taskId, commentId, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  // Helper for UI: all tasks assigned to the caller in their current workspace.
  app.get("/my-tasks", async (req) => {
    const { memberId, workspaceId } = req.auth!;
    const rows = await db
      .select()
      .from(tasks)
      .innerJoin(taskAssignees, eq(taskAssignees.taskId, tasks.id))
      .where(
        and(
          eq(taskAssignees.memberId, memberId!),
          eq(tasks.workspaceId, workspaceId!),
          eq(tasks.archived, false),
        ),
      )
      .orderBy(asc(tasks.status), asc(tasks.position));
    return { tasks: await hydrateTasks(rows.map((r) => r.tasks)) };
  });
}
