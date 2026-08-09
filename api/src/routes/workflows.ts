import { Transform } from "node:stream";
import { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  webhookEndpoints,
  webhookEvents,
  workflowRuns,
  workflows,
  workflowSteps,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { config } from "../lib/config.js";
import { id, rawToken } from "../lib/ids.js";
import { decryptSecret, encryptSecret } from "../lib/secret-box.js";
import { verifyWebhookSignature } from "../lib/signed-webhook.js";
import { parseWorkflowDefinition } from "../lib/workflow-definition.js";
import { resumeWorkflowFromHuman, startWorkflowRun } from "../lib/workflow-engine.js";

declare module "fastify" {
  interface FastifyRequest {
    rawWebhookBody?: Buffer;
  }
}

const CreateWorkflow = z.object({
  name: z.string().min(1).max(140),
  description: z.string().max(3_000).optional(),
  triggerType: z.enum(["manual", "webhook"]).optional(),
  definition: z.unknown(),
});

const PatchWorkflow = z.object({
  name: z.string().min(1).max(140).optional(),
  description: z.string().max(3_000).optional(),
  status: z.enum(["active", "paused"]).optional(),
  triggerType: z.enum(["manual", "webhook"]).optional(),
  definition: z.unknown().optional(),
});

function endpointUrl(endpointId: string): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/hooks/${endpointId}`;
}

function isWebhookRequest(req: FastifyRequest): boolean {
  return (req.raw.url ?? "").split("?")[0].includes("/hooks/");
}

export default async function workflowRoutes(app: FastifyInstance): Promise<void> {
  // Tee the exact bytes into `rawWebhookBody` while leaving the stream intact
  // for Fastify's normal JSON parser. HMAC therefore covers what the sender
  // actually sent, not a re-serialized approximation.
  app.addHook("preParsing", (req, _reply, payload, done) => {
    if (!isWebhookRequest(req)) return done(null, payload);
    const chunks: Buffer[] = [];
    const tee = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      },
      flush(callback) {
        req.rawWebhookBody = Buffer.concat(chunks);
        callback();
      },
    });
    done(null, payload.pipe(tee));
  });

  app.get("/workflows", { preHandler: requireWorkspace }, async (req) => {
    const workspaceId = req.auth!.workspaceId!;
    const rows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.workspaceId, workspaceId))
      .orderBy(desc(workflows.updatedAt));
    const workflowIds = rows.map((row) => row.id);
    const runs = workflowIds.length
      ? await db
          .select()
          .from(workflowRuns)
          .where(inArray(workflowRuns.workflowId, workflowIds))
          .orderBy(desc(workflowRuns.startedAt))
      : [];
    const endpoints = workflowIds.length
      ? await db.select().from(webhookEndpoints).where(inArray(webhookEndpoints.workflowId, workflowIds))
      : [];
    return {
      workflows: rows.map((workflow) => ({
        ...workflow,
        latestRuns: runs.filter((run) => run.workflowId === workflow.id).slice(0, 10),
        endpoints: endpoints
          .filter((endpoint) => endpoint.workflowId === workflow.id)
          .map(({ secretCiphertext: _secret, ...endpoint }) => ({ ...endpoint, url: endpointUrl(endpoint.id) })),
      })),
    };
  });

  app.post("/workflows", { preHandler: requireWorkspace }, async (req, reply) => {
    const body = CreateWorkflow.parse(req.body);
    let definition;
    try { definition = parseWorkflowDefinition(body.definition); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const workflowId = id("wf");
    await db.insert(workflows).values({
      id: workflowId,
      workspaceId: req.auth!.workspaceId!,
      name: body.name,
      description: body.description ?? "",
      triggerType: body.triggerType ?? "manual",
      definitionJson: definition,
      createdBy: req.auth!.memberId!,
    });
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
    return reply.code(201).send({ workflow });
  });

  app.patch("/workflows/:id", { preHandler: requireWorkspace }, async (req, reply) => {
    const workflowId = (req.params as { id: string }).id;
    const body = PatchWorkflow.parse(req.body);
    const [existing] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "workflow_not_found" });
    let definition = existing.definitionJson;
    if (body.definition !== undefined) {
      try { definition = parseWorkflowDefinition(body.definition); }
      catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    }
    await db
      .update(workflows)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.triggerType !== undefined ? { triggerType: body.triggerType } : {}),
        definitionJson: definition,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, workflowId));
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
    return { workflow };
  });

  app.post("/workflows/:id/runs", { preHandler: requireWorkspace }, async (req, reply) => {
    const workflowId = (req.params as { id: string }).id;
    const body = z.object({ input: z.record(z.string(), z.unknown()).default({}) }).parse(req.body ?? {});
    try {
      const runId = await startWorkflowRun({
        workflowId,
        workspaceId: req.auth!.workspaceId!,
        payload: body.input,
        createdBy: req.auth!.memberId!,
      });
      return reply.code(202).send({ runId });
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message === "workflow_not_found" ? 404 : 409).send({ error: message });
    }
  });

  app.get("/workflow-runs/:id", { preHandler: requireWorkspace }, async (req, reply) => {
    const runId = (req.params as { id: string }).id;
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!run) return reply.code(404).send({ error: "workflow_run_not_found" });
    const steps = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.runId, runId))
      .orderBy(workflowSteps.startedAt);
    return { run, steps };
  });

  app.post("/workflow-runs/:id/resume", { preHandler: requireWorkspace }, async (req, reply) => {
    const runId = (req.params as { id: string }).id;
    const body = z
      .object({ approved: z.boolean(), output: z.record(z.string(), z.unknown()).default({}) })
      .parse(req.body ?? {});
    try {
      await resumeWorkflowFromHuman({
        runId,
        workspaceId: req.auth!.workspaceId!,
        approved: body.approved,
        output: body.output,
      });
      return reply.code(202).send({ ok: true });
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message === "workflow_run_not_found" ? 404 : 409).send({ error: message });
    }
  });

  app.post("/workflows/:id/webhooks", { preHandler: requireWorkspace }, async (req, reply) => {
    const workflowId = (req.params as { id: string }).id;
    const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    const [workflow] = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!workflow) return reply.code(404).send({ error: "workflow_not_found" });
    const endpointId = id("hook");
    const signingSecret = `whsec_${rawToken(48)}`;
    await db.insert(webhookEndpoints).values({
      id: endpointId,
      workspaceId: req.auth!.workspaceId!,
      workflowId,
      name: body.name,
      secretCiphertext: encryptSecret({ signingSecret }),
      createdBy: req.auth!.memberId!,
    });
    return reply.code(201).send({
      endpoint: { id: endpointId, workflowId, name: body.name, url: endpointUrl(endpointId), active: true },
      signingSecret,
      signature: "sha256=HMAC_SHA256(secret, `${X-CircleChat-Timestamp}.${rawBody}`)",
    });
  });

  app.post("/webhooks/:id/rotate", { preHandler: requireWorkspace }, async (req, reply) => {
    const endpointId = (req.params as { id: string }).id;
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!endpoint) return reply.code(404).send({ error: "webhook_endpoint_not_found" });
    const signingSecret = `whsec_${rawToken(48)}`;
    await db
      .update(webhookEndpoints)
      .set({ secretCiphertext: encryptSecret({ signingSecret }) })
      .where(eq(webhookEndpoints.id, endpointId));
    return { signingSecret };
  });

  app.post("/hooks/:endpointId", async (req, reply) => {
    const endpointId = (req.params as { endpointId: string }).endpointId;
    const deliveryId = String(req.headers["x-circlechat-delivery"] ?? "").trim();
    if (!deliveryId || deliveryId.length > 120) return reply.code(400).send({ error: "delivery_id_required" });
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId))
      .limit(1);
    if (!endpoint || !endpoint.active) return reply.code(404).send({ error: "webhook_endpoint_not_found" });
    const payload = z.record(z.string(), z.unknown()).parse(req.body ?? {});
    const eventId = id("whevt");
    const inserted = await db
      .insert(webhookEvents)
      .values({ id: eventId, endpointId, deliveryId, payloadJson: payload })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (!inserted.length) {
      const [prior] = await db
        .select({ workflowRunId: webhookEvents.workflowRunId, status: webhookEvents.status })
        .from(webhookEvents)
        .where(and(eq(webhookEvents.endpointId, endpointId), eq(webhookEvents.deliveryId, deliveryId)))
        .limit(1);
      return { duplicate: true, runId: prior?.workflowRunId ?? null, status: prior?.status ?? "duplicate" };
    }
    const { signingSecret } = decryptSecret<{ signingSecret: string }>(endpoint.secretCiphertext);
    const verification = verifyWebhookSignature({
      secret: signingSecret,
      timestamp: typeof req.headers["x-circlechat-timestamp"] === "string"
        ? req.headers["x-circlechat-timestamp"]
        : undefined,
      signature: typeof req.headers["x-circlechat-signature"] === "string"
        ? req.headers["x-circlechat-signature"]
        : undefined,
      rawBody: req.rawWebhookBody ?? Buffer.from(JSON.stringify(payload)),
    });
    if (!verification.ok) {
      await db
        .update(webhookEvents)
        .set({ status: "rejected", signatureValid: false, errorText: verification.error })
        .where(eq(webhookEvents.id, eventId));
      return reply.code(401).send({ error: verification.error });
    }
    try {
      const runId = await startWorkflowRun({
        workflowId: endpoint.workflowId,
        workspaceId: endpoint.workspaceId,
        payload,
        createdBy: endpoint.id,
      });
      await db
        .update(webhookEvents)
        .set({ status: "accepted", signatureValid: true, workflowRunId: runId })
        .where(eq(webhookEvents.id, eventId));
      return reply.code(202).send({ accepted: true, runId });
    } catch (error) {
      await db
        .update(webhookEvents)
        .set({ status: "rejected", signatureValid: true, errorText: (error as Error).message.slice(0, 500) })
        .where(eq(webhookEvents.id, eventId));
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
}
