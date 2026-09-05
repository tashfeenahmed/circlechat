import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, agents, modelRoutes, modelUsageEvents } from "../db/schema.js";
import { id } from "./ids.js";
import {
  calculateUsageCost,
  chooseModelTier,
  normalizeUsage,
  selectConfiguredRoute,
  type ModelRouteRecord,
  type ReportedModelUsageInput,
} from "./model-routing.js";

export async function modelRecommendation(input: {
  workspaceId: string;
  trigger: string;
  text?: string;
  requestedTier?: string | null;
}): Promise<{
  tier: string;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
}> {
  const tier = chooseModelTier(input);
  const rows = await db.select().from(modelRoutes).where(eq(modelRoutes.workspaceId, input.workspaceId));
  const route = selectConfiguredRoute(rows as ModelRouteRecord[], tier);
  return {
    tier,
    provider: route?.provider ?? null,
    model: route?.model ?? null,
    contextWindow: route?.contextWindow ?? null,
  };
}

export async function recordModelUsage(input: {
  workspaceId: string;
  agentId: string;
  runId: string;
  routeTier?: string | null;
  usage: ReportedModelUsageInput;
  source: "reported" | "estimated";
  eventKey?: string;
}): Promise<{ tokens: number; costUsd: number }> {
  const usage = normalizeUsage(input.usage);
  const routes = await db.select().from(modelRoutes).where(eq(modelRoutes.workspaceId, input.workspaceId));
  const route = selectConfiguredRoute(
    routes as ModelRouteRecord[],
    (input.routeTier as "economy" | "balanced" | "frontier" | "advisor") ?? "balanced",
  );
  const costUsd = calculateUsageCost(usage, route);
  const [agent] = await db
    .select({ model: agents.model, configJson: agents.configJson })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  // Last-resort provider/model: what the agent was installed with, if the
  // installer recorded it (configJson.provider / configJson.model). Better
  // than "unknown"/"auto" when neither the runtime nor a model route says.
  const cfg = (agent?.configJson ?? {}) as { provider?: unknown; model?: unknown };
  const cfgProvider = typeof cfg.provider === "string" && cfg.provider ? cfg.provider.slice(0, 60) : null;
  const cfgModel = typeof cfg.model === "string" && cfg.model ? cfg.model.slice(0, 120) : null;
  const agentModel = agent?.model && agent.model !== "auto" ? agent.model : null;
  const usageId = id("usage");
  const eventKey = input.eventKey ?? usageId;
  const values = {
    id: usageId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    runId: input.runId,
    eventKey,
    provider: usage.provider ?? route?.provider ?? cfgProvider ?? "unknown",
    model: usage.model ?? route?.model ?? agentModel ?? cfgModel ?? agent?.model ?? "unknown",
    routeTier: input.routeTier ?? null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    costUsd,
    source: input.source,
  };
  await db
    .insert(modelUsageEvents)
    .values(values)
    .onConflictDoUpdate({
      target: [modelUsageEvents.runId, modelUsageEvents.eventKey],
      set: {
        provider: values.provider,
        model: values.model,
        routeTier: values.routeTier,
        inputTokens: values.inputTokens,
        outputTokens: values.outputTokens,
        cachedInputTokens: values.cachedInputTokens,
        costUsd: values.costUsd,
        source: values.source,
        occurredAt: new Date(),
      },
    });
  return { tokens: usage.inputTokens + usage.outputTokens, costUsd };
}

// Runtime-side reporting can arrive after the worker wrote an estimate. Replace
// the run aggregate with the sum of reported events when any exist; otherwise
// keep estimates. This avoids charging both estimated and actual usage.
export async function refreshAgentRunUsage(runId: string): Promise<void> {
  const [totals] = await db
    .select({
      tokens: sql<number>`coalesce(sum(${modelUsageEvents.inputTokens} + ${modelUsageEvents.outputTokens}), 0)::int`,
      cost: sql<number>`coalesce(sum(${modelUsageEvents.costUsd}), 0)::float`,
    })
    .from(modelUsageEvents)
    .where(and(eq(modelUsageEvents.runId, runId), eq(modelUsageEvents.source, "reported")));
  if ((totals?.tokens ?? 0) <= 0 && (totals?.cost ?? 0) <= 0) return;
  await db
    .update(agentRuns)
    .set({ tokensEst: totals.tokens, costUsd: totals.cost })
    .where(eq(agentRuns.id, runId));
}
