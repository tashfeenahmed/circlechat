import { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceMembers } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { loadTask } from "../lib/tasks-core.js";
import {
  createArtifact,
  currentArtifacts,
  loadArtifact,
  softDeleteArtifact,
  artifactCount,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS_PER_TASK,
} from "../lib/task-artifacts.js";

// Human-facing task artifacts. Same durable store the agent API and the
// executor write to — this is the board UI's view + drag-drop upload + delete.
// Reads of the bytes go through GET /files/<key> (object auth), so list just
// returns ready-to-fetch descriptors.
export default async function taskArtifactRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/tasks/:id/artifacts", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const ws = req.auth!.workspaceId!;
    const t = await loadTask(taskId);
    if (!t || t.workspaceId !== ws) return reply.code(404).send({ error: "not_found" });
    return { artifacts: await currentArtifacts(taskId) };
  });

  app.post("/tasks/:id/artifacts", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const ws = req.auth!.workspaceId!;
    const t = await loadTask(taskId);
    if (!t || t.workspaceId !== ws) return reply.code(404).send({ error: "not_found" });
    if (!req.isMultipart()) return reply.code(400).send({ error: "expected_multipart" });
    if ((await artifactCount(taskId)) >= MAX_ARTIFACTS_PER_TASK)
      return reply.code(422).send({ error: "too_many_artifacts" });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "no_file" });
    const buffer = await data.toBuffer();
    if (buffer.length > MAX_ARTIFACT_BYTES)
      return reply.code(413).send({ error: "too_large", maxBytes: MAX_ARTIFACT_BYTES });

    const art = await createArtifact({
      taskId,
      workspaceId: ws,
      name: data.filename || "file",
      buffer,
      contentType: data.mimetype || "application/octet-stream",
      createdBy: req.auth!.memberId!,
    });
    return reply.send({ artifact: art });
  });

  // Soft-delete a single artifact version. Author or workspace admin only —
  // ownership is re-derived from the DB (mirrors POST /files/delete).
  app.delete("/tasks/:id/artifacts/:artifactId", async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const artifactId = (req.params as { artifactId: string }).artifactId;
    const ws = req.auth!.workspaceId!;
    const memberId = req.auth!.memberId!;
    const userId = req.auth!.userId;

    const art = await loadArtifact(artifactId);
    if (!art || art.taskId !== taskId || art.workspaceId !== ws)
      return reply.code(404).send({ error: "not_found" });

    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.userId, userId)))
      .limit(1);
    const isAdmin = wm?.role === "admin";
    if (art.createdBy !== memberId && !isAdmin)
      return reply.code(403).send({ error: "not_author" });

    await softDeleteArtifact(artifactId);
    return { ok: true };
  });
}
