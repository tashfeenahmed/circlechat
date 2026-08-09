export type ModelTier = "economy" | "balanced" | "frontier" | "advisor";

export interface ModelRouteRecord {
  tier: string;
  provider: string;
  model: string;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  cachedInputCostPerMtok: number;
  contextWindow: number | null;
  enabled: boolean;
}

export interface ReportedModelUsage {
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

const FRONTIER_SIGNALS = /\b(architecture|security|incident|migration|production|legal|financial|strategy|root cause|trade-?off|data loss)\b/i;
const ADVISOR_SIGNALS = /\b(board|executive|high stakes|irreversible|compliance|acquisition|termination|breach)\b/i;

export function chooseModelTier(input: {
  trigger: string;
  text?: string;
  requestedTier?: string | null;
}): ModelTier {
  if (["economy", "balanced", "frontier", "advisor"].includes(input.requestedTier ?? "")) {
    return input.requestedTier as ModelTier;
  }
  const text = input.text ?? "";
  if (ADVISOR_SIGNALS.test(text)) return "advisor";
  if (FRONTIER_SIGNALS.test(text) || text.length > 5000) return "frontier";
  if (input.trigger === "scheduled" || input.trigger === "ambient") return "economy";
  if (input.trigger === "approval_response") return "frontier";
  return "balanced";
}

export function selectConfiguredRoute(
  routes: ModelRouteRecord[],
  wanted: ModelTier,
): ModelRouteRecord | null {
  const enabled = routes.filter((route) => route.enabled);
  const exact = enabled.find((route) => route.tier === wanted);
  if (exact) return exact;
  const fallbackOrder: ModelTier[] = ["balanced", "frontier", "economy", "advisor"];
  for (const tier of fallbackOrder) {
    const route = enabled.find((candidate) => candidate.tier === tier);
    if (route) return route;
  }
  return null;
}

export function calculateUsageCost(usage: ReportedModelUsage, route: ModelRouteRecord | null): number {
  if (usage.costUsd != null && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) return usage.costUsd;
  if (!route) return 0;
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  return (
    (uncachedInput * route.inputCostPerMtok +
      cached * route.cachedInputCostPerMtok +
      Math.max(0, usage.outputTokens) * route.outputCostPerMtok) /
    1_000_000
  );
}

export function normalizeUsage(input: ReportedModelUsage): ReportedModelUsage {
  const integer = (value: number | undefined): number =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
  return {
    provider: input.provider?.slice(0, 60),
    model: input.model?.slice(0, 120),
    inputTokens: integer(input.inputTokens),
    outputTokens: integer(input.outputTokens),
    cachedInputTokens: Math.min(integer(input.cachedInputTokens), integer(input.inputTokens)),
    ...(input.costUsd != null && Number.isFinite(input.costUsd)
      ? { costUsd: Math.max(0, input.costUsd) }
      : {}),
  };
}
