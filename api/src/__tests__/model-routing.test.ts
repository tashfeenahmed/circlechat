import { describe, expect, it } from "vitest";
import {
  calculateUsageCost,
  chooseModelTier,
  normalizeUsage,
  selectConfiguredRoute,
  type ModelRouteRecord,
} from "../lib/model-routing.js";

const route = (tier: string, enabled = true): ModelRouteRecord => ({
  tier,
  enabled,
  provider: "test",
  model: `model-${tier}`,
  inputCostPerMtok: 2,
  outputCostPerMtok: 8,
  cachedInputCostPerMtok: 0.5,
  contextWindow: 100_000,
});

describe("model routing", () => {
  it("uses economy for background work and escalates high-stakes text", () => {
    expect(chooseModelTier({ trigger: "scheduled" })).toBe("economy");
    expect(chooseModelTier({ trigger: "task_assigned", text: "Production security architecture migration" })).toBe("frontier");
    expect(chooseModelTier({ trigger: "dm", text: "Board decision after a breach" })).toBe("advisor");
    expect(chooseModelTier({ trigger: "dm", requestedTier: "economy" })).toBe("economy");
  });

  it("falls back only to enabled routes", () => {
    expect(selectConfiguredRoute([route("frontier", false), route("balanced")], "frontier")?.tier).toBe("balanced");
    expect(selectConfiguredRoute([], "balanced")).toBeNull();
  });

  it("prices cached and uncached tokens independently", () => {
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 250_000, outputTokens: 100_000 }, route("balanced")))
      .toBeCloseTo(2.425);
    expect(calculateUsageCost({ inputTokens: 100, outputTokens: 100, costUsd: 0.123 }, route("balanced")))
      .toBe(0.123);
  });

  it("normalizes malformed counters", () => {
    expect(normalizeUsage({ inputTokens: -10, outputTokens: 2.9, cachedInputTokens: 99 })).toMatchObject({
      inputTokens: 0,
      outputTokens: 2,
      cachedInputTokens: 0,
    });
  });

  it("accepts OpenAI / Anthropic / camelCase usage key spellings", () => {
    expect(normalizeUsage({ prompt_tokens: 120, completion_tokens: 30 })).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(normalizeUsage({ input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 20 })).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 20,
    });
    expect(normalizeUsage({ promptTokens: 5, completionTokens: 7, cost_usd: 0.01 })).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
      costUsd: 0.01,
    });
  });

  it("derives output from total when only total + input are reported", () => {
    expect(normalizeUsage({ prompt_tokens: 100, total_tokens: 140 })).toMatchObject({ inputTokens: 100, outputTokens: 40 });
  });

  it("canonical keys win over aliases and still clamp/floor", () => {
    expect(normalizeUsage({ inputTokens: 10.9, outputTokens: -3, prompt_tokens: 999, cachedInputTokens: 50 })).toMatchObject({
      inputTokens: 10,
      outputTokens: 0,
      cachedInputTokens: 10,
    });
  });
});
