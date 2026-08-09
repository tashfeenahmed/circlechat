import { FastifyInstance } from "fastify";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { modelRoutes, modelUsageEvents } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";

const Tiers = ["economy", "balanced", "frontier", "advisor"] as const;

export default async function modelRoutingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/model-routing", { preHandler: requireWorkspace }, async (req) => {
    const workspaceId = req.auth!.workspaceId!;
    const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query ?? {});
    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);
    const routes = await db
      .select()
      .from(modelRoutes)
      .where(eq(modelRoutes.workspaceId, workspaceId))
      .orderBy(modelRoutes.tier);
    const usage = await db
      .select({
        provider: modelUsageEvents.provider,
        model: modelUsageEvents.model,
        routeTier: modelUsageEvents.routeTier,
        source: modelUsageEvents.source,
        inputTokens: sql<number>`sum(${modelUsageEvents.inputTokens})::int`,
        outputTokens: sql<number>`sum(${modelUsageEvents.outputTokens})::int`,
        cachedInputTokens: sql<number>`sum(${modelUsageEvents.cachedInputTokens})::int`,
        costUsd: sql<number>`sum(${modelUsageEvents.costUsd})::float`,
        events: sql<number>`count(*)::int`,
      })
      .from(modelUsageEvents)
      .where(and(eq(modelUsageEvents.workspaceId, workspaceId), gte(modelUsageEvents.occurredAt, since)))
      .groupBy(
        modelUsageEvents.provider,
        modelUsageEvents.model,
        modelUsageEvents.routeTier,
        modelUsageEvents.source,
      )
      .orderBy(desc(sql`sum(${modelUsageEvents.costUsd})`));
    return {
      tiers: Tiers,
      routes,
      usage,
      totals: usage.reduce(
        (total, row) => ({
          inputTokens: total.inputTokens + row.inputTokens,
          outputTokens: total.outputTokens + row.outputTokens,
          cachedInputTokens: total.cachedInputTokens + row.cachedInputTokens,
          costUsd: total.costUsd + row.costUsd,
          events: total.events + row.events,
          reportedEvents: total.reportedEvents + (row.source === "reported" ? row.events : 0),
        }),
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, events: 0, reportedEvents: 0 },
      ),
    };
  });

  app.put("/model-routing/:tier", { preHandler: requireWorkspace }, async (req, reply) => {
    const tier = z.enum(Tiers).parse((req.params as { tier: string }).tier);
    const body = z
      .object({
        provider: z.string().min(1).max(60),
        model: z.string().min(1).max(120),
        inputCostPerMtok: z.number().min(0).max(1_000),
        outputCostPerMtok: z.number().min(0).max(1_000),
        cachedInputCostPerMtok: z.number().min(0).max(1_000).default(0),
        contextWindow: z.number().int().min(1_000).max(100_000_000).nullable().optional(),
        enabled: z.boolean().default(true),
      })
      .parse(req.body);
    const workspaceId = req.auth!.workspaceId!;
    await db
      .insert(modelRoutes)
      .values({
        workspaceId,
        tier,
        ...body,
        contextWindow: body.contextWindow ?? null,
        updatedBy: req.auth!.memberId!,
      })
      .onConflictDoUpdate({
        target: [modelRoutes.workspaceId, modelRoutes.tier],
        set: { ...body, contextWindow: body.contextWindow ?? null, updatedBy: req.auth!.memberId!, updatedAt: new Date() },
      });
    const [route] = await db
      .select()
      .from(modelRoutes)
      .where(and(eq(modelRoutes.workspaceId, workspaceId), eq(modelRoutes.tier, tier)))
      .limit(1);
    return reply.send({ route });
  });
}
