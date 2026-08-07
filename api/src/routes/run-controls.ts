import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { agentRuns, agents, workflowRuns } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { requirePermission, writeAudit } from "../lib/access-control.js";
import { agentQueue } from "../agents/queue.js";

const ControlBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), reason: z.string().max(1_000).optional() }),
  z.object({ action: z.literal("steer"), text: z.string().min(1).max(10_000) }),
  z.object({ action: z.literal("follow_up"), text: z.string().min(1).max(10_000) }),
  z.object({ action: z.literal("extend"), seconds: z.number().int().min(1).max(604_800) }),
  z.object({ action: z.literal("claim") }),
  z.object({ action: z.literal("release") }),
]);

async function allowed(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await requirePermission(req, "runs.control")) return true;
  reply.code(403).send({ error: "permission_denied", permission: "runs.control" });
  return false;
}

function item(text: string, memberId: string) {
  return { id: `ctl_${crypto.randomUUID()}`, text, createdBy: memberId, createdAt: new Date().toISOString() };
}

async function record(req: FastifyRequest, action: string, type: string, targetId: string, meta: Record<string, unknown> = {}) {
  await writeAudit({
    workspaceId: req.auth!.workspaceId!, actorId: req.auth!.memberId!, action,
    targetType: type, targetId, meta, ip: req.ip,
  });
}

export default async function runControlRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/active-runs", async (req) => {
    const agentRows = await db.select({ run: agentRuns, agentName: agents.name })
      .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(and(eq(agents.workspaceId, req.auth!.workspaceId!), inArray(agentRuns.status, ["queued", "running"])))
      .orderBy(desc(agentRuns.startedAt)).limit(100);
    const workflowRows = await db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.workspaceId, req.auth!.workspaceId!), inArray(workflowRuns.status, ["queued", "running", "waiting"])))
      .orderBy(desc(workflowRuns.startedAt)).limit(100);
    return {
      runs: [
        ...agentRows.map((row) => ({ type: "agent" as const, name: row.agentName, ...row.run })),
        ...workflowRows.map((run) => ({ type: "workflow" as const, name: `Workflow ${run.workflowId}`, ...run })),
      ].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
    };
  });

  app.post("/agent-runs/:id/control", async (req, reply) => {
    if (!(await allowed(req, reply))) return;
    const runId = (req.params as { id: string }).id;
    const body = ControlBody.parse(req.body);
    const [row] = await db.select({ run: agentRuns, workspaceId: agents.workspaceId })
      .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(and(eq(agentRuns.id, runId), eq(agents.workspaceId, req.auth!.workspaceId!))).limit(1);
    if (!row) return reply.code(404).send({ error: "agent_run_not_found" });
    if (row.run.ownerMemberId && row.run.ownerMemberId !== req.auth!.memberId! && !(await requirePermission(req, "*"))) {
      return reply.code(409).send({ error: "run_owned_by_another_member", ownerMemberId: row.run.ownerMemberId });
    }
    if (body.action === "cancel") {
      if (["ok", "failed", "cancelled"].includes(row.run.status)) return reply.code(409).send({ error: "run_terminal" });
      await db.update(agentRuns).set({
        status: "cancelled", cancelRequestedAt: new Date(), cancelledBy: req.auth!.memberId!,
        errorText: body.reason ?? "cancelled_by_user", finishedAt: new Date(),
      }).where(eq(agentRuns.id, runId));
      const job = await agentQueue.getJob(runId);
      if (job && (await job.getState()) !== "active") await job.remove().catch(() => {});
    } else if (body.action === "steer") {
      await db.update(agentRuns).set({ steerJson: [...row.run.steerJson, item(body.text, req.auth!.memberId!)] }).where(eq(agentRuns.id, runId));
    } else if (body.action === "follow_up") {
      await db.update(agentRuns).set({ followupJson: [...row.run.followupJson, item(body.text, req.auth!.memberId!)] }).where(eq(agentRuns.id, runId));
    } else if (body.action === "extend") {
      const base = Math.max(Date.now(), row.run.timeoutAt?.getTime() ?? 0);
      await db.update(agentRuns).set({ timeoutAt: new Date(base + body.seconds * 1_000) }).where(eq(agentRuns.id, runId));
    } else {
      await db.update(agentRuns).set({ ownerMemberId: body.action === "claim" ? req.auth!.memberId! : null }).where(eq(agentRuns.id, runId));
    }
    await record(req, `agent_run.${body.action}`, "agent_run", runId, body.action === "cancel" ? { reason: body.reason ?? "" } : {});
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    return { run };
  });

  app.post("/workflow-runs/:id/control", async (req, reply) => {
    if (!(await allowed(req, reply))) return;
    const runId = (req.params as { id: string }).id;
    const body = ControlBody.parse(req.body);
    const [run] = await db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, req.auth!.workspaceId!))).limit(1);
    if (!run) return reply.code(404).send({ error: "workflow_run_not_found" });
    if (run.ownerMemberId && run.ownerMemberId !== req.auth!.memberId! && !(await requirePermission(req, "*"))) {
      return reply.code(409).send({ error: "run_owned_by_another_member", ownerMemberId: run.ownerMemberId });
    }
    if (body.action === "cancel") {
      if (["completed", "failed", "cancelled"].includes(run.status)) return reply.code(409).send({ error: "run_terminal" });
      await db.update(workflowRuns).set({
        status: "cancelled", cancelRequestedAt: new Date(), cancelledBy: req.auth!.memberId!,
        errorText: body.reason ?? "cancelled_by_user", finishedAt: new Date(), updatedAt: new Date(),
      }).where(eq(workflowRuns.id, runId));
    } else if (body.action === "steer") {
      await db.update(workflowRuns).set({ steerJson: [...run.steerJson, item(body.text, req.auth!.memberId!)], updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
    } else if (body.action === "follow_up") {
      await db.update(workflowRuns).set({ followupJson: [...run.followupJson, item(body.text, req.auth!.memberId!)], updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
    } else if (body.action === "extend") {
      const base = Math.max(Date.now(), run.timeoutAt?.getTime() ?? 0);
      await db.update(workflowRuns).set({ timeoutAt: new Date(base + body.seconds * 1_000), updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
    } else {
      await db.update(workflowRuns).set({ ownerMemberId: body.action === "claim" ? req.auth!.memberId! : null, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
    }
    await record(req, `workflow_run.${body.action}`, "workflow_run", runId, body.action === "cancel" ? { reason: body.reason ?? "" } : {});
    const [updated] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    return { run: updated };
  });
}
