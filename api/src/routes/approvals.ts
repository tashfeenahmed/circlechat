import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { approvals, agents } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { enqueueAgentEvent } from "../agents/enqueue.js";
import { publishToConversation } from "../lib/events.js";

const DecideBody = z.object({ decision: z.enum(["approve", "deny"]) });

export default async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/approvals", async (req) => {
    const { workspaceId } = req.auth!;
    const rows = await db
      .select({ approval: approvals })
      .from(approvals)
      .innerJoin(agents, eq(agents.id, approvals.agentId))
      .where(and(eq(approvals.status, "pending"), eq(agents.workspaceId, workspaceId!)))
      .orderBy(desc(approvals.createdAt))
      .limit(100);
    return { approvals: rows.map((r) => r.approval) };
  });

  app.post("/approvals/:id", async (req, reply) => {
    const apId = (req.params as { id: string }).id;
    const body = DecideBody.parse(req.body);
    const { memberId } = req.auth!;
    const [a] = await db.select().from(approvals).where(eq(approvals.id, apId)).limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    if (a.status !== "pending") return reply.code(409).send({ error: "already_decided" });

    const status = body.decision === "approve" ? "approved" : "denied";
    await db
      .update(approvals)
      .set({ status, decidedAt: new Date(), decidedBy: memberId })
      .where(eq(approvals.id, apId));

    if (a.conversationId) {
      await publishToConversation(a.conversationId, {
        type: "approval.decided",
        approvalId: apId,
        status,
      });
    }

    // Wake the agent with an approval_response trigger so it can act on it.
    const [ag] = await db.select().from(agents).where(eq(agents.id, a.agentId)).limit(1);
    if (ag) {
      await enqueueAgentEvent(a.agentId, {
        trigger: "approval_response",
        approvalId: apId,
        status,
        conversationId: a.conversationId ?? undefined,
      });
    }

    return { ok: true, status };
  });
}
