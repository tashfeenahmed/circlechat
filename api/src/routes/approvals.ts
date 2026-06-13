import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { approvals, agents } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { enqueueAgentEvent } from "../agents/enqueue.js";
import { applyApprovedActionPayload } from "../agents/executor.js";
import { publishToConversation } from "../lib/events.js";
import {
  deliverAgentSecrets,
  SECRET_NAME_RE,
  MAX_SECRETS_PER_DECISION,
} from "../lib/agent-secrets.js";

const DecideBody = z
  .object({
    decision: z.enum(["approve", "deny"]),
    // Optional human comment delivered to the agent with the decision —
    // "approved, but only the staging list" / "denied, use the shared drive".
    note: z.string().trim().max(2000).optional(),
    // Optional credentials to install into the agent's environment alongside
    // an approve ({"NETLIFY_TOKEN": "…"}). Values are written to the agent
    // home's .env — never persisted in the DB, events, or chat; only the
    // names ride along so the agent knows what it received.
    secrets: z.record(z.string().regex(SECRET_NAME_RE), z.string().min(1).max(4096)).optional(),
  })
  .refine((b) => !b.secrets || Object.keys(b.secrets).length <= MAX_SECRETS_PER_DECISION, {
    message: "too_many_secrets",
  })
  .refine((b) => !(b.decision === "deny" && b.secrets && Object.keys(b.secrets).length), {
    message: "secrets_on_deny",
  });

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
    const note = body.note || null;

    const [ag] = await db.select().from(agents).where(eq(agents.id, a.agentId)).limit(1);

    // Install attached credentials into the agent's env BEFORE marking the
    // approval decided — if delivery fails the decision doesn't land, so the
    // agent is never told "approved" about credentials it can't see.
    let deliveredSecrets: string[] | null = null;
    if (status === "approved" && body.secrets && Object.keys(body.secrets).length) {
      if (!ag) return reply.code(404).send({ error: "agent_not_found" });
      try {
        deliveredSecrets = await deliverAgentSecrets(ag, body.secrets);
      } catch (e) {
        req.log.error({ err: e, approvalId: apId }, "secret delivery failed");
        return reply.code(500).send({ error: "secret_delivery_failed" });
      }
    }

    // Durable replay (#8): on approval, execute the original action server-side
    // from its stored payload instead of waiting for the agent to re-emit it —
    // so an approval can't be wasted by an agent that woke without re-deriving
    // what it asked for. Only fires for executor-performable actions; a
    // request_approval for external work isn't auto-replayable and still relies
    // on the agent acting with the delivered secrets. On success the approval
    // goes straight to "applied" so the agent's re-emit (if any) can't double it.
    let autoApplied = false;
    if (status === "approved") {
      const replay = await applyApprovedActionPayload(a.agentId, a.payloadJson).catch(() => ({
        applied: false,
        errors: [],
        trace: [],
      }));
      autoApplied = replay.applied;
    }
    const finalStatus = autoApplied ? "applied" : status;

    await db
      .update(approvals)
      .set({
        status: finalStatus,
        decidedAt: new Date(),
        decidedBy: memberId,
        decisionNote: note,
        ...(deliveredSecrets?.length ? { deliveredSecrets } : {}),
      })
      .where(eq(approvals.id, apId));

    if (a.conversationId) {
      await publishToConversation(a.conversationId, {
        type: "approval.decided",
        approvalId: apId,
        status,
        ...(note ? { note } : {}),
        ...(deliveredSecrets?.length ? { deliveredSecrets } : {}),
      });
    }

    // Wake the agent with an approval_response trigger so it can act on it.
    if (ag) {
      await enqueueAgentEvent(a.agentId, {
        trigger: "approval_response",
        approvalId: apId,
        status,
        conversationId: a.conversationId ?? undefined,
      });
    }

    return { ok: true, status, ...(deliveredSecrets?.length ? { deliveredSecrets } : {}) };
  });
}
