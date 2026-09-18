import { describe, expect, it } from "vitest";
import { PROVIDER_DEFAULT_MODELS, resolveDefaultModel } from "../lib/provider-defaults.js";

describe("provider default models", () => {
  it("keeps the caller's explicit model", () => {
    expect(resolveDefaultModel("openrouter", "google/gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
    expect(resolveDefaultModel("openrouter", "  ")).toBe(PROVIDER_DEFAULT_MODELS.openrouter);
  });

  it("never lets a non-Anthropic provider inherit the Anthropic-native template id", () => {
    for (const [provider, model] of Object.entries(PROVIDER_DEFAULT_MODELS)) {
      if (provider === "anthropic") continue;
      expect(model, provider).not.toBe("claude-sonnet-4-5");
    }
  });

  it("uses OpenRouter's vendor/model slug format", () => {
    expect(resolveDefaultModel("openrouter")).toMatch(/^[a-z0-9-]+\/[a-z0-9.:-]+$/);
    expect(resolveDefaultModel("anthropic")).not.toContain("/");
  });

  it("leaves Nous to pick its own default", () => {
    expect(resolveDefaultModel("nous")).toBeUndefined();
  });
});
