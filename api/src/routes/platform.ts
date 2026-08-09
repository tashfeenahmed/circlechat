import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  agents,
  appDeployments,
  appLogs,
  boardStages,
  connectors,
  conversationMembers,
  conversations,
  decisionMemories,
  hostedApps,
  members,
  prRooms,
  taskArtifacts,
  tasks,
  teamBlueprints,
  workflows,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { id, rawToken } from "../lib/ids.js";
import { config } from "../lib/config.js";
import { readObject } from "../lib/storage.js";
import { invokeConnector } from "../lib/connector-runtime.js";
import { parseWorkflowDefinition } from "../lib/workflow-definition.js";
import { requirePermission, writeAudit } from "../lib/access-control.js";
import {
  appContentSecurityPolicy,
  BOARD_STAGE_KEYS,
  DECISION_KINDS,
  normalizePrSnapshot,
  safeSlug,
  StageRulesSchema,
  TeamBlueprintSchema,
  type NormalizedPrSnapshot,
} from "../lib/p1-platform.js";

const DecisionBody = z.object({
  kind: z.enum(DECISION_KINDS),
  title: z.string().min(1).max(180),
  decision: z.string().min(1).max(20_000),
  rationale: z.string().max(20_000).optional(),
  alternatives: z.array(z.string().max(5_000)).max(30).optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(["observer", "reflector", "human", "agent"]).optional(),
});

const StageBody = z.object({
  title: z.string().min(1).max(80),
  position: z.number().int().min(0).max(100),
  instructions: z.string().max(10_000).optional(),
  entryRules: StageRulesSchema.optional(),
  exitRules: StageRulesSchema.optional(),
  agentId: z.string().nullable().optional(),
  skill: z.string().max(120).nullable().optional(),
  verification: z.enum(["none", "artifact", "judge", "human"]).optional(),
  escalationMemberId: z.string().nullable().optional(),
  nextStage: z.enum(BOARD_STAGE_KEYS).nullable().optional(),
});

const AppBody = z.object({
  taskId: z.string().min(1),
  artifactId: z.string().min(1),
  name: z.string().min(1).max(140),
  slug: z.string().max(80).optional(),
});

const PrRoomBody = z.object({
  conversationId: z.string().min(1),
  connectorId: z.string().nullable().optional(),
  provider: z.enum(["github", "gitlab"]),
  repository: z.string().min(1).max(240),
  prNumber: z.number().int().positive(),
  snapshot: z.unknown().optional(),
});

const DEFAULT_STAGES = [
  { stage: "backlog", title: "Backlog", position: 0, nextStage: "in_progress" },
  { stage: "in_progress", title: "In progress", position: 1, nextStage: "review" },
  { stage: "blocked", title: "Blocked", position: 2, nextStage: "in_progress" },
  { stage: "review", title: "Review", position: 3, nextStage: "done" },
  { stage: "done", title: "Done", position: 4, nextStage: null },
] as const;

function baseUrl(): string {
  return config.publicBaseUrl.replace(/\/$/, "");
}
async function canWrite(req: FastifyRequest, reply: FastifyReply, permission = "workspace.write"): Promise<boolean> {
  if (await requirePermission(req, permission)) return true;
  reply.code(403).send({ error: "permission_denied", permission });
  return false;
}

async function audit(req: FastifyRequest, action: string, targetType: string, targetId?: string, meta?: Record<string, unknown>) {
  await writeAudit({
    workspaceId: req.auth!.workspaceId!,
    actorId: req.auth!.memberId!,
    action,
    targetType,
    targetId,
    meta,
    ip: req.ip,
  });
}

export default async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  // ── Decision / precedent memory ───────────────────────────────────────
  app.get("/decisions", async (req) => {
    const rows = await db
      .select()
      .from(decisionMemories)
      .where(eq(decisionMemories.workspaceId, req.auth!.workspaceId!))
      .orderBy(desc(decisionMemories.createdAt));
    return { decisions: rows };
  });

  app.post("/decisions/observe", async (req, reply) => {
    if (!(await canWrite(req, reply))) return;
    const body = DecisionBody.parse(req.body);
    const memoryId = id("dec");
    await db.insert(decisionMemories).values({
      id: memoryId,
      workspaceId: req.auth!.workspaceId!,
      kind: body.kind,
      title: body.title,
      decision: body.decision,
      rationale: body.rationale ?? "",
      alternativesJson: body.alternatives ?? [],
      provenanceJson: body.provenance ?? {},
      source: body.source ?? "observer",
      createdBy: req.auth!.memberId!,
    });
    await audit(req, "decision.observed", "decision", memoryId, { kind: body.kind, source: body.source ?? "observer" });
    const [memory] = await db.select().from(decisionMemories).where(eq(decisionMemories.id, memoryId)).limit(1);
    return reply.code(201).send({ memory });
  });

  app.post("/decisions/:id/correct", async (req, reply) => {
    if (!(await canWrite(req, reply))) return;
    const priorId = (req.params as { id: string }).id;
    const body = DecisionBody.parse(req.body);
    const [prior] = await db
      .select()
      .from(decisionMemories)
      .where(and(eq(decisionMemories.id, priorId), eq(decisionMemories.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!prior) return reply.code(404).send({ error: "decision_not_found" });
    if (prior.status !== "active") return reply.code(409).send({ error: "decision_not_active" });
    const nextId = id("dec");
    await db.transaction(async (tx) => {
      await tx.update(decisionMemories).set({ status: "corrected", correctedAt: new Date() }).where(eq(decisionMemories.id, priorId));
      await tx.insert(decisionMemories).values({
        id: nextId,
        workspaceId: prior.workspaceId,
        kind: body.kind,
        title: body.title,
        decision: body.decision,
        rationale: body.rationale ?? "",
        alternativesJson: body.alternatives ?? [],
        provenanceJson: { ...body.provenance, correctionOf: priorId },
        source: "human",
        supersedesId: priorId,
        createdBy: req.auth!.memberId!,
      });
    });
    await audit(req, "decision.corrected", "decision", nextId, { supersedesId: priorId });
    const [memory] = await db.select().from(decisionMemories).where(eq(decisionMemories.id, nextId)).limit(1);
    return { memory };
  });

  // ── Isolated app preview and approval-gated publication ───────────────
  app.get("/apps", async (req) => {
    const rows = await db.select().from(hostedApps).where(eq(hostedApps.workspaceId, req.auth!.workspaceId!)).orderBy(desc(hostedApps.updatedAt));
    const ids = rows.map((row) => row.id);
    const [deployments, logs] = ids.length
      ? await Promise.all([
          db.select().from(appDeployments).where(inArray(appDeployments.appId, ids)).orderBy(desc(appDeployments.createdAt)),
          db.select().from(appLogs).where(inArray(appLogs.appId, ids)).orderBy(desc(appLogs.createdAt)),
        ])
      : [[], []];
    return {
      apps: rows.map((row) => ({
        ...row,
        previewUrl: `${baseUrl()}/app-preview/${row.previewToken}`,
        publicUrl: `${baseUrl()}/apps/${row.slug}`,
        deployments: deployments.filter((deployment) => deployment.appId === row.id),
        logs: logs.filter((log) => log.appId === row.id).slice(0, 20),
      })),
    };
  });

  app.post("/apps", async (req, reply) => {
    if (!(await canWrite(req, reply))) return;
    const body = AppBody.parse(req.body);
    const [artifact] = await db
      .select({ artifact: taskArtifacts, taskWorkspaceId: tasks.workspaceId })
      .from(taskArtifacts)
      .innerJoin(tasks, eq(tasks.id, taskArtifacts.taskId))
      .where(and(eq(taskArtifacts.id, body.artifactId), eq(taskArtifacts.taskId, body.taskId)))
      .limit(1);
    if (!artifact || artifact.taskWorkspaceId !== req.auth!.workspaceId! || artifact.artifact.deletedAt) {
      return reply.code(404).send({ error: "artifact_not_found" });
    }
    if (!artifact.artifact.contentType.includes("html") || artifact.artifact.size > 2 * 1024 * 1024) {
      return reply.code(422).send({ error: "html_artifact_required", maxBytes: 2 * 1024 * 1024 });
    }
    const appId = id("app");
    const deploymentId = id("deploy");
    const suffix = rawToken(6).toLowerCase();
    const slug = `${safeSlug(body.slug ?? body.name)}-${suffix}`.slice(0, 80);
    await db.transaction(async (tx) => {
      await tx.insert(hostedApps).values({
        id: appId,
        workspaceId: req.auth!.workspaceId!,
        taskId: body.taskId,
        name: body.name,
        slug,
        previewToken: rawToken(40),
        activeDeploymentId: deploymentId,
        createdBy: req.auth!.memberId!,
      });
      await tx.insert(appDeployments).values({
        id: deploymentId,
        appId,
        artifactId: body.artifactId,
        artifactSha256: artifact.artifact.sha256,
        status: "preview",
        requestedBy: req.auth!.memberId!,
      });
      await tx.insert(appLogs).values({ id: id("applog"), appId, deploymentId, event: "preview.created", message: artifact.artifact.name });
    });
    await audit(req, "app.preview_created", "app", appId, { deploymentId, artifactId: body.artifactId });
    return reply.code(201).send({ appId, deploymentId });
  });

  app.post("/apps/:id/request-publish", async (req, reply) => {
    if (!(await canWrite(req, reply, "apps.request_publish"))) return;
    const appId = (req.params as { id: string }).id;
    const [row] = await db.select().from(hostedApps).where(and(eq(hostedApps.id, appId), eq(hostedApps.workspaceId, req.auth!.workspaceId!))).limit(1);
    if (!row || !row.activeDeploymentId) return reply.code(404).send({ error: "app_not_found" });
    if (row.status !== "preview") return reply.code(409).send({ error: "app_not_in_preview" });
    await db.transaction(async (tx) => {
      await tx.update(hostedApps).set({ status: "pending", updatedAt: new Date() }).where(eq(hostedApps.id, appId));
      await tx.update(appDeployments).set({ status: "pending" }).where(eq(appDeployments.id, row.activeDeploymentId!));
      await tx.insert(appLogs).values({ id: id("applog"), appId, deploymentId: row.activeDeploymentId, event: "publish.requested", message: "Awaiting human approval" });
    });
    await audit(req, "app.publish_requested", "app", appId);
    return { ok: true, status: "pending" };
  });

  app.post("/apps/:id/review", async (req, reply) => {
    if (!(await canWrite(req, reply, "*"))) return;
    const appId = (req.params as { id: string }).id;
    const body = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2_000).optional() }).parse(req.body);
    const [row] = await db.select().from(hostedApps).where(and(eq(hostedApps.id, appId), eq(hostedApps.workspaceId, req.auth!.workspaceId!))).limit(1);
    if (!row || !row.activeDeploymentId) return reply.code(404).send({ error: "app_not_found" });
    if (row.status !== "pending") return reply.code(409).send({ error: "app_not_pending" });
    const approved = body.decision === "approve";
    await db.transaction(async (tx) => {
      await tx.update(hostedApps).set({ status: approved ? "published" : "preview", updatedAt: new Date() }).where(eq(hostedApps.id, appId));
      await tx.update(appDeployments).set({
        status: approved ? "published" : "rejected",
        reviewedBy: req.auth!.memberId!,
        reviewNote: body.note ?? null,
        publishedAt: approved ? new Date() : null,
      }).where(eq(appDeployments.id, row.activeDeploymentId!));
      await tx.insert(appLogs).values({
        id: id("applog"), appId, deploymentId: row.activeDeploymentId,
        event: approved ? "publish.approved" : "publish.rejected", message: body.note ?? "",
      });
    });
    await audit(req, `app.publish_${approved ? "approved" : "rejected"}`, "app", appId, { note: body.note ?? "" });
    return { ok: true, status: approved ? "published" : "preview" };
  });

  app.get("/apps/:id/health", async (req, reply) => {
    const appId = (req.params as { id: string }).id;
    const [row] = await db
      .select({ app: hostedApps, deployment: appDeployments, artifact: taskArtifacts })
      .from(hostedApps)
      .innerJoin(appDeployments, eq(appDeployments.id, hostedApps.activeDeploymentId))
      .innerJoin(taskArtifacts, eq(taskArtifacts.id, appDeployments.artifactId))
      .where(and(eq(hostedApps.id, appId), eq(hostedApps.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "app_not_found" });
    const bytes = await readObject(row.artifact.storageKey);
    const healthy = Boolean(bytes && bytes.length === row.artifact.size && row.artifact.deletedAt === null);
    await db.update(appDeployments).set({ healthStatus: healthy ? "healthy" : "error" }).where(eq(appDeployments.id, row.deployment.id));
    return { healthy, status: row.app.status, deploymentId: row.deployment.id, bytes: bytes?.length ?? 0 };
  });

  // ── Provider-backed PR rooms ──────────────────────────────────────────
  app.get("/pr-rooms", async (req) => {
    const rows = await db.select().from(prRooms).where(eq(prRooms.workspaceId, req.auth!.workspaceId!)).orderBy(desc(prRooms.createdAt));
    return { rooms: rows };
  });

  app.post("/pr-rooms", async (req, reply) => {
    if (!(await canWrite(req, reply))) return;
    const body = PrRoomBody.parse(req.body);
    const [conversation] = await db.select().from(conversations).where(and(eq(conversations.id, body.conversationId), eq(conversations.workspaceId, req.auth!.workspaceId!))).limit(1);
    if (!conversation || conversation.kind !== "channel") return reply.code(404).send({ error: "channel_not_found" });
    if (body.connectorId) {
      const [connector] = await db.select({ id: connectors.id }).from(connectors).where(and(eq(connectors.id, body.connectorId), eq(connectors.workspaceId, req.auth!.workspaceId!))).limit(1);
      if (!connector) return reply.code(404).send({ error: "connector_not_found" });
    }
    const snapshot = body.snapshot === undefined ? emptyPrSnapshot() : normalizePrSnapshot(body.provider, body.snapshot);
    const roomId = id("prroom");
    await db.insert(prRooms).values({
      id: roomId,
      workspaceId: req.auth!.workspaceId!,
      conversationId: body.conversationId,
      connectorId: body.connectorId ?? null,
      provider: body.provider,
      repository: body.repository,
      prNumber: body.prNumber,
      title: snapshot.title,
      url: snapshot.url,
      state: snapshot.state,
      headRef: snapshot.headRef,
      baseRef: snapshot.baseRef,
      diffJson: snapshot.diff,
      checksJson: snapshot.checks,
      reviewsJson: snapshot.reviews,
      protectionJson: snapshot.protection,
      lastSyncedAt: body.snapshot === undefined ? null : new Date(),
      createdBy: req.auth!.memberId!,
    });
    await audit(req, "pr_room.created", "pr_room", roomId, { provider: body.provider, repository: body.repository, prNumber: body.prNumber });
    return reply.code(201).send({ roomId });
  });

  app.post("/pr-rooms/:id/sync", async (req, reply) => {
    if (!(await canWrite(req, reply))) return;
    const roomId = (req.params as { id: string }).id;
    const body = z.object({ snapshot: z.unknown().optional() }).parse(req.body ?? {});
    const [room] = await db.select().from(prRooms).where(and(eq(prRooms.id, roomId), eq(prRooms.workspaceId, req.auth!.workspaceId!))).limit(1);
    if (!room) return reply.code(404).send({ error: "pr_room_not_found" });
    try {
      const snapshot = body.snapshot === undefined ? await fetchPrSnapshot(room) : normalizePrSnapshot(room.provider as "github" | "gitlab", body.snapshot);
      await db.update(prRooms).set({
        title: snapshot.title, url: snapshot.url, state: snapshot.state,
        headRef: snapshot.headRef, baseRef: snapshot.baseRef,
        diffJson: snapshot.diff, checksJson: snapshot.checks, reviewsJson: snapshot.reviews,
        protectionJson: snapshot.protection, lastSyncedAt: new Date(), lastError: null,
      }).where(eq(prRooms.id, roomId));
      await audit(req, "pr_room.synced", "pr_room", roomId, { checks: snapshot.checks.length, files: snapshot.diff.length });
      return { room: { ...room, ...snapshot, lastSyncedAt: new Date().toISOString() } };
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await db.update(prRooms).set({ lastError: message, lastSyncedAt: new Date() }).where(eq(prRooms.id, roomId));
      return reply.code(502).send({ error: "pr_sync_failed", detail: message });
    }
  });

  // ── Executable board stages ───────────────────────────────────────────
  app.get("/board-stages", async (req) => {
    const stored = await db.select().from(boardStages).where(eq(boardStages.workspaceId, req.auth!.workspaceId!)).orderBy(asc(boardStages.position));
    const byKey = new Map(stored.map((stage) => [stage.stage, stage]));
    return {
      stages: DEFAULT_STAGES.map((fallback) => byKey.get(fallback.stage) ?? {
        workspaceId: req.auth!.workspaceId!, stage: fallback.stage, title: fallback.title,
        position: fallback.position, instructions: "", entryRulesJson: {}, exitRulesJson: {},
        agentId: null, skill: null, verification: "none", escalationMemberId: null,
        nextStage: fallback.nextStage, updatedBy: null, updatedAt: null,
      }).sort((a, b) => a.position - b.position),
    };
  });

  app.put("/board-stages/:stage", async (req, reply) => {
    if (!(await canWrite(req, reply))) return;
    const stage = z.enum(BOARD_STAGE_KEYS).parse((req.params as { stage: string }).stage);
    const body = StageBody.parse(req.body);
    if (body.agentId) {
      const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, body.agentId), eq(agents.workspaceId, req.auth!.workspaceId!))).limit(1);
      if (!agent) return reply.code(404).send({ error: "agent_not_found" });
    }
    await db.insert(boardStages).values({
      workspaceId: req.auth!.workspaceId!, stage, title: body.title, position: body.position,
      instructions: body.instructions ?? "", entryRulesJson: body.entryRules ?? {}, exitRulesJson: body.exitRules ?? {},
      agentId: body.agentId ?? null, skill: body.skill ?? null, verification: body.verification ?? "none",
      escalationMemberId: body.escalationMemberId ?? null, nextStage: body.nextStage ?? null,
      updatedBy: req.auth!.memberId!,
    }).onConflictDoUpdate({
      target: [boardStages.workspaceId, boardStages.stage],
      set: {
        title: body.title, position: body.position, instructions: body.instructions ?? "",
        entryRulesJson: body.entryRules ?? {}, exitRulesJson: body.exitRules ?? {}, agentId: body.agentId ?? null,
        skill: body.skill ?? null, verification: body.verification ?? "none",
        escalationMemberId: body.escalationMemberId ?? null, nextStage: body.nextStage ?? null,
        updatedBy: req.auth!.memberId!, updatedAt: new Date(),
      },
    });
    await audit(req, "board_stage.configured", "board_stage", stage, { verification: body.verification ?? "none" });
    const [row] = await db.select().from(boardStages).where(and(eq(boardStages.workspaceId, req.auth!.workspaceId!), eq(boardStages.stage, stage))).limit(1);
    return { stage: row };
  });

  // ── Versioned, reusable team blueprints ───────────────────────────────
  app.get("/team-blueprints", async (req) => {
    const rows = await db.select().from(teamBlueprints).where(eq(teamBlueprints.workspaceId, req.auth!.workspaceId!)).orderBy(desc(teamBlueprints.updatedAt));
    return { blueprints: rows };
  });

  app.post("/team-blueprints", async (req, reply) => {
    if (!(await canWrite(req, reply))) return;
    const body = z.object({
      name: z.string().min(1).max(140), description: z.string().max(3_000).optional(),
      definition: TeamBlueprintSchema.optional(), exportWorkspace: z.boolean().optional(),
    }).parse(req.body);
    const definition = body.exportWorkspace ? await exportWorkspaceBlueprint(req.auth!.workspaceId!) : TeamBlueprintSchema.parse(body.definition ?? {});
    const [latest] = await db.select({ version: teamBlueprints.version }).from(teamBlueprints)
      .where(and(eq(teamBlueprints.workspaceId, req.auth!.workspaceId!), eq(teamBlueprints.name, body.name)))
      .orderBy(desc(teamBlueprints.version)).limit(1);
    const blueprintId = id("blueprint");
    const version = (latest?.version ?? 0) + 1;
    await db.insert(teamBlueprints).values({
      id: blueprintId, workspaceId: req.auth!.workspaceId!, name: body.name,
      description: body.description ?? "", version, definitionJson: definition,
      createdBy: req.auth!.memberId!,
    });
    await audit(req, "blueprint.created", "team_blueprint", blueprintId, { version, exportWorkspace: Boolean(body.exportWorkspace) });
    return reply.code(201).send({ blueprintId, version, definition });
  });

  app.post("/team-blueprints/:id/apply", async (req, reply) => {
    if (!(await canWrite(req, reply))) return;
    const blueprintId = (req.params as { id: string }).id;
    const [blueprint] = await db.select().from(teamBlueprints).where(and(eq(teamBlueprints.id, blueprintId), eq(teamBlueprints.workspaceId, req.auth!.workspaceId!))).limit(1);
    if (!blueprint) return reply.code(404).send({ error: "blueprint_not_found" });
    const result = await applyBlueprint(TeamBlueprintSchema.parse(blueprint.definitionJson), req.auth!.workspaceId!, req.auth!.memberId!);
    await audit(req, "blueprint.applied", "team_blueprint", blueprintId, result);
    return reply.code(201).send(result);
  });
}

function emptyPrSnapshot(): NormalizedPrSnapshot {
  return { title: "", url: "", state: "open", headRef: "", baseRef: "", diff: [], checks: [], reviews: [], protection: {} };
}

async function connectorCall(connector: typeof connectors.$inferSelect, path: string): Promise<unknown> {
  return (await invokeConnector(connector, { method: "GET", path, input: {}, steps: {} })).data;
}

async function fetchPrSnapshot(room: typeof prRooms.$inferSelect): Promise<NormalizedPrSnapshot> {
  if (!room.connectorId) throw new Error("connector_required");
  const [connector] = await db.select().from(connectors).where(and(eq(connectors.id, room.connectorId), eq(connectors.workspaceId, room.workspaceId))).limit(1);
  if (!connector) throw new Error("connector_not_found");
  if (room.provider === "github") {
    const prefix = `repos/${room.repository}/pulls/${room.prNumber}`;
    const pull = await connectorCall(connector, prefix) as Record<string, unknown>;
    const sha = String((pull.head as Record<string, unknown> | undefined)?.sha ?? "");
    const baseRef = String((pull.base as Record<string, unknown> | undefined)?.ref ?? "");
    const [files, reviews, checks, protection] = await Promise.all([
      connectorCall(connector, `${prefix}/files`),
      connectorCall(connector, `${prefix}/reviews`),
      sha ? connectorCall(connector, `repos/${room.repository}/commits/${sha}/check-runs`) : Promise.resolve([]),
      baseRef ? connectorCall(connector, `repos/${room.repository}/branches/${encodeURIComponent(baseRef)}/protection`).catch(() => ({})) : Promise.resolve({}),
    ]);
    return normalizePrSnapshot("github", { pull, files, reviews, checks: (checks as Record<string, unknown>)?.check_runs ?? checks, protection });
  }
  const project = encodeURIComponent(room.repository);
  const prefix = `projects/${project}/merge_requests/${room.prNumber}`;
  const [mergeRequest, changes, pipelines, approvals] = await Promise.all([
    connectorCall(connector, prefix), connectorCall(connector, `${prefix}/changes`),
    connectorCall(connector, `${prefix}/pipelines`), connectorCall(connector, `${prefix}/approvals`),
  ]);
  return normalizePrSnapshot("gitlab", { mergeRequest, changes, pipelines, approvals });
}

async function exportWorkspaceBlueprint(workspaceId: string) {
  const [agentRows, memberRows, channelRows, workflowRows] = await Promise.all([
    db.select().from(agents).where(eq(agents.workspaceId, workspaceId)),
    db.select().from(members).where(and(eq(members.workspaceId, workspaceId), eq(members.kind, "agent"))),
    db.select().from(conversations).where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.kind, "channel"))),
    db.select().from(workflows).where(eq(workflows.workspaceId, workspaceId)),
  ]);
  const keyByMember = new Map(memberRows.map((member) => [member.id, agentRows.find((agent) => agent.id === member.refId)?.handle ?? member.refId]));
  return TeamBlueprintSchema.parse({
    agents: agentRows.map((agent) => ({
      key: agent.handle, name: agent.name, handle: agent.handle, title: agent.title, brief: agent.brief,
      capabilities: agent.capabilities, scopes: agent.scopes, budgetUsdMonth: agent.budgetUsdMonth,
    })),
    relationships: memberRows.map((member) => ({ childKey: keyByMember.get(member.id)!, parentKey: member.reportsTo ? keyByMember.get(member.reportsTo) ?? null : null })),
    skills: agentRows.flatMap((agent) => {
      const names = Array.isArray(agent.configJson.blueprintSkills) ? agent.configJson.blueprintSkills : [];
      return names.filter((name): name is string => typeof name === "string").map((name) => ({ agentKey: agent.handle, name }));
    }),
    channels: channelRows.map((channel) => ({ name: channel.name ?? "channel", topic: channel.topic })),
    workflows: workflowRows.map((workflow) => ({ name: workflow.name, description: workflow.description, triggerType: workflow.triggerType, definition: workflow.definitionJson })),
  });
}

async function applyBlueprint(definition: z.infer<typeof TeamBlueprintSchema>, workspaceId: string, creatorMemberId: string): Promise<Record<string, number>> {
  const suffix = rawToken(5).toLowerCase();
  const memberByKey = new Map<string, string>();
  for (const spec of definition.agents) {
    const agentId = id("agent");
    const memberId = id("m");
    const handle = `${safeSlug(spec.handle).slice(0, 30)}-${suffix}`.slice(0, 40);
    const blueprintSkills = definition.skills.filter((skill) => skill.agentKey === spec.key).map((skill) => skill.name);
    await db.transaction(async (tx) => {
      await tx.insert(agents).values({
        id: agentId, workspaceId, handle, name: spec.name, kind: "custom", adapter: "webhook",
        configJson: { blueprintSkills }, model: "", scopes: spec.scopes ?? [], capabilities: spec.capabilities ?? [],
        status: "idle", budgetUsdMonth: spec.budgetUsdMonth ?? null, title: spec.title ?? "", brief: spec.brief ?? "",
        heartbeatIntervalSec: 86_400, botToken: `cc_bot_${rawToken(48)}`, createdBy: creatorMemberId,
      });
      await tx.insert(members).values({ id: memberId, workspaceId, kind: "agent", refId: agentId });
    });
    memberByKey.set(spec.key, memberId);
  }
  for (const relation of definition.relationships) {
    const child = memberByKey.get(relation.childKey);
    const parent = relation.parentKey ? memberByKey.get(relation.parentKey) ?? null : null;
    if (child) await db.update(members).set({ reportsTo: parent }).where(eq(members.id, child));
  }
  let channelCount = 0;
  for (const spec of definition.channels) {
    const conversationId = id("c");
    await db.insert(conversations).values({ id: conversationId, workspaceId, kind: "channel", name: `${safeSlug(spec.name)}-${suffix}`.slice(0, 100), topic: spec.topic ?? "", isPrivate: true, createdBy: creatorMemberId });
    const participantIds = [creatorMemberId, ...(spec.memberKeys ?? []).map((key) => memberByKey.get(key)).filter((value): value is string => Boolean(value))];
    await db.insert(conversationMembers).values(Array.from(new Set(participantIds)).map((memberId) => ({ conversationId, memberId, role: memberId === creatorMemberId ? "admin" : "member" }))).onConflictDoNothing();
    channelCount += 1;
  }
  let workflowCount = 0;
  for (const spec of definition.workflows) {
    const parsed = parseWorkflowDefinition(spec.definition);
    await db.insert(workflows).values({ id: id("wf"), workspaceId, name: `${spec.name} ${suffix}`, description: spec.description ?? "", triggerType: spec.triggerType ?? "manual", definitionJson: parsed, createdBy: creatorMemberId });
    workflowCount += 1;
  }
  return { agents: definition.agents.length, relationships: definition.relationships.length, skills: definition.skills.length, channels: channelCount, workflows: workflowCount };
}

export async function appServeRoutes(app: FastifyInstance): Promise<void> {
  async function serve(reply: FastifyReply, row: { app: typeof hostedApps.$inferSelect; deployment: typeof appDeployments.$inferSelect; artifact: typeof taskArtifacts.$inferSelect }, preview: boolean) {
    const bytes = await readObject(row.artifact.storageKey);
    if (!bytes || row.artifact.deletedAt) return reply.code(410).type("text/plain").send("Deployment artifact is unavailable.");
    void db.insert(appLogs).values({
      id: id("applog"), appId: row.app.id, deploymentId: row.deployment.id,
      event: preview ? "preview.request" : "app.request", message: "GET /",
    }).catch(() => {});
    return reply
      .header("content-security-policy", appContentSecurityPolicy())
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", preview ? "no-store" : "public, max-age=60")
      .type("text/html; charset=utf-8")
      .send(bytes);
  }

  app.get("/app-preview/:token", async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const [row] = await db.select({ app: hostedApps, deployment: appDeployments, artifact: taskArtifacts })
      .from(hostedApps).innerJoin(appDeployments, eq(appDeployments.id, hostedApps.activeDeploymentId))
      .innerJoin(taskArtifacts, eq(taskArtifacts.id, appDeployments.artifactId))
      .where(eq(hostedApps.previewToken, token)).limit(1);
    if (!row || row.app.status === "disabled") return reply.code(404).type("text/plain").send("Preview not found.");
    return serve(reply, row, true);
  });

  app.get("/apps/:slug", async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const [row] = await db.select({ app: hostedApps, deployment: appDeployments, artifact: taskArtifacts })
      .from(hostedApps).innerJoin(appDeployments, eq(appDeployments.id, hostedApps.activeDeploymentId))
      .innerJoin(taskArtifacts, eq(taskArtifacts.id, appDeployments.artifactId))
      .where(and(eq(hostedApps.slug, slug), eq(hostedApps.status, "published"), eq(appDeployments.status, "published"))).limit(1);
    if (!row) return reply.code(404).type("text/plain").send("App not found.");
    return serve(reply, row, false);
  });
}
