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

// Loose shape a runtime/bridge/gateway may hand us. Runtimes disagree on key
// names — OpenAI-compatible gateways report `prompt_tokens`/`completion_tokens`,
// Anthropic-style `input_tokens`/`output_tokens`, some bridges camelCase. The
// fishbowl recorded output_tokens=0 on 1,130/1,130 rows because nothing ever
// arrived under `outputTokens`; accept every common spelling so a report is
// never silently zeroed.
export interface ReportedModelUsageInput {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  // aliases
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cachedTokens?: number;
  total_tokens?: number;
  totalTokens?: number;
  cost_usd?: number;
  cost?: number;
}

function firstFinite(...values: Array<number | undefined>): number | undefined {
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

export function normalizeUsage(input: ReportedModelUsageInput): ReportedModelUsage {
  const integer = (value: number | undefined): number =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
  const inputRaw = firstFinite(input.inputTokens, input.input_tokens, input.prompt_tokens, input.promptTokens);
  let outputRaw = firstFinite(input.outputTokens, input.output_tokens, input.completion_tokens, input.completionTokens);
  const total = firstFinite(input.total_tokens, input.totalTokens);
  // Only a total and an input → derive output rather than record 0.
  if (outputRaw === undefined && total !== undefined && inputRaw !== undefined) {
    outputRaw = Math.max(0, total - inputRaw);
  }
  const cachedRaw = firstFinite(
    input.cachedInputTokens,
    input.cached_input_tokens,
    input.cache_read_input_tokens,
    input.cachedTokens,
  );
  const costRaw = firstFinite(input.costUsd, input.cost_usd, input.cost);
  const inputTokens = integer(inputRaw);
  return {
    provider: input.provider?.slice(0, 60),
    model: input.model?.slice(0, 120),
    inputTokens,
    outputTokens: integer(outputRaw),
    cachedInputTokens: Math.min(integer(cachedRaw), inputTokens),
    ...(costRaw != null ? { costUsd: Math.max(0, costRaw) } : {}),
  };
}
