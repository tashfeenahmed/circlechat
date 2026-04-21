import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks, taskAssignees } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
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
});
const CommentBody = z.object({
  bodyMd: z.string().min(1).max(20000),
  mentions: z.array(z.string()).optional(),
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
  if (result.error) return reply.code(ERR_CODE[result.error] ?? 400).send({ error: result.error });
  return result;
}

export default async function tasksRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/tasks", async (req) => {
    return await listTasks(req.auth!.workspaceId!);
  });

  app.post("/tasks", async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const r = await createTask(body, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.get("/tasks/:id", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const r = await getTaskDetail(taskId, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.patch("/tasks/:id", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const body = UpdateBody.parse(req.body);
    const r = await updateTask(taskId, body, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
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
