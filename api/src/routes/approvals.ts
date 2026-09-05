import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { approvals, agents } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { enqueueAgentEvent } from "../agents/enqueue.js";
import { applyApprovedActionPayload } from "../agents/executor.js";
import { publishToConversation, publishToWorkspace } from "../lib/events.js";
import { requirePermission, writeAudit } from "../lib/access-control.js";
import { approvalExpiresAt } from "../lib/approval-policy.js";
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

const ListQuery = z.object({
  // pending (default, what the Approvals page shows) | decided | all
  status: z.enum(["pending", "decided", "all"]).optional(),
});
const DECIDED = ["approved", "denied", "applied", "expired"];

export default async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/approvals", async (req) => {
    const { workspaceId } = req.auth!;
    const q = ListQuery.parse(req.query ?? {});
    const statusFilter =
      q.status === "all" ? undefined : q.status === "decided" ? inArray(approvals.status, DECIDED) : eq(approvals.status, "pending");
    const rows = await db
      .select({ approval: approvals })
      .from(approvals)
      .innerJoin(agents, eq(agents.id, approvals.agentId))
      .where(and(eq(agents.workspaceId, workspaceId!), statusFilter))
      .orderBy(desc(approvals.createdAt))
      .limit(100);
    return {
      approvals: rows.map((r) => ({
        ...r.approval,
        // When the card will auto-expire if nobody decides (null = never).
        expiresAt: r.approval.status === "pending" ? approvalExpiresAt(r.approval.createdAt) : null,
      })),
    };
  });

  app.post("/approvals/:id", async (req, reply) => {
    const apId = (req.params as { id: string }).id;
    const body = DecideBody.parse(req.body);
    const { memberId, workspaceId } = req.auth!;

    // Deciding an approval is a governance action: admins and members, never
    // guests (BUILTIN_PERMISSIONS) — custom roles need `approvals.decide`.
    if (!(await requirePermission(req, "approvals.decide"))) {
      return reply.code(403).send({ error: "forbidden" });
    }

    // Workspace scoping: the card must belong to an agent in the caller's
    // current workspace. Previously any authenticated user could decide any
    // approval by id, across workspaces.
    const [found] = await db
      .select({ approval: approvals, agent: agents })
      .from(approvals)
      .innerJoin(agents, eq(agents.id, approvals.agentId))
      .where(and(eq(approvals.id, apId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!found) return reply.code(404).send({ error: "not_found" });
    const a = found.approval;
    const ag = found.agent;
    if (a.status !== "pending") return reply.code(409).send({ error: "already_decided", status: a.status });

    const status = body.decision === "approve" ? "approved" : "denied";
    const note = body.note || null;
    const now = new Date();

    // Claim the decision atomically (status-guarded UPDATE). Two humans
    // clicking at once used to both pass the check above, both deliver
    // secrets, and both replay the action — the loser now gets a 409.
    const claimed = await db
      .update(approvals)
      .set({ status, decidedAt: now, decidedBy: memberId, decisionNote: note })
      .where(and(eq(approvals.id, apId), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (!claimed.length) return reply.code(409).send({ error: "already_decided" });

    // Install attached credentials into the agent's env. If delivery fails the
    // claim is rolled back to pending, so the agent is never told "approved"
    // about credentials it can't see and the human can retry.
    let deliveredSecrets: string[] | null = null;
    if (status === "approved" && body.secrets && Object.keys(body.secrets).length) {
      try {
        deliveredSecrets = await deliverAgentSecrets(ag, body.secrets);
      } catch (e) {
        req.log.error({ err: e, approvalId: apId }, "secret delivery failed");
        await db
          .update(approvals)
          .set({ status: "pending", decidedAt: null, decidedBy: null, decisionNote: null })
          .where(eq(approvals.id, apId));
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

    if (finalStatus !== status || deliveredSecrets?.length) {
      await db
        .update(approvals)
        .set({
          status: finalStatus,
          ...(deliveredSecrets?.length ? { deliveredSecrets } : {}),
        })
        .where(eq(approvals.id, apId));
    }

    await writeAudit({
      workspaceId: workspaceId!,
      actorId: memberId!,
      action: `approval.${status}`,
      targetType: "approval",
      targetId: apId,
      // Names only — secret values never reach the DB, events, or logs.
      meta: { scope: a.scope, agentId: a.agentId, autoApplied, ...(deliveredSecrets?.length ? { deliveredSecrets } : {}) },
      ip: req.ip,
    }).catch(() => {});

    const frame = {
      type: "approval.decided" as const,
      approvalId: apId,
      status: finalStatus,
      ...(note ? { note } : {}),
      ...(deliveredSecrets?.length ? { deliveredSecrets } : {}),
    };
    await publishToWorkspace(workspaceId!, frame).catch(() => {});
    if (a.conversationId) await publishToConversation(a.conversationId, frame).catch(() => {});

    // Wake the agent with an approval_response trigger so it can act on it.
    await enqueueAgentEvent(a.agentId, {
      trigger: "approval_response",
      approvalId: apId,
      status: finalStatus,
      conversationId: a.conversationId ?? undefined,
    });

    return { ok: true, status: finalStatus, ...(deliveredSecrets?.length ? { deliveredSecrets } : {}) };
  });
}
