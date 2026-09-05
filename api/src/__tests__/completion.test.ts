import { describe, it, expect } from "vitest";
import {
  resolveJudgeTarget,
  resolvePlannerTarget,
  plannerUsesEmbeddingsFallback,
  extractJson,
} from "../lib/completion.js";

// The live fishbowl had ONLY EMBEDDINGS_BASE_URL/EMBEDDINGS_MODEL set. The old
// resolver silently pointed the judge at that URL with model=auto and logged
// an "outage" on every flip. The judge must now require an explicit chat URL.
const embeddingsOnly = {
  EMBEDDINGS_BASE_URL: "https://freellm.example/v1/",
  EMBEDDINGS_MODEL: "gemini-embedding-001",
  EMBEDDINGS_API_KEY: "ek",
};

describe("resolveJudgeTarget", () => {
  it("is NOT configured when only an embeddings endpoint exists", () => {
    expect(resolveJudgeTarget(embeddingsOnly)).toBeNull();
  });

  it("uses PLANNER_BASE_URL / PLANNER_MODEL when set", () => {
    const t = resolveJudgeTarget({ ...embeddingsOnly, PLANNER_BASE_URL: "http://gw/v1/", PLANNER_MODEL: "gemini-2.5-pro" });
    expect(t).toEqual({ baseUrl: "http://gw/v1", apiKey: "ek", model: "gemini-2.5-pro" });
  });

  it("prefers VERIFY_JUDGE_* over PLANNER_*", () => {
    const t = resolveJudgeTarget({
      PLANNER_BASE_URL: "http://planner/v1",
      PLANNER_MODEL: "auto",
      PLANNER_API_KEY: "pk",
      VERIFY_JUDGE_BASE_URL: "http://judge/v1",
      VERIFY_JUDGE_MODEL: "gpt-x",
      VERIFY_JUDGE_API_KEY: "jk",
    });
    expect(t).toEqual({ baseUrl: "http://judge/v1", apiKey: "jk", model: "gpt-x" });
  });

  it("defaults the model to auto", () => {
    expect(resolveJudgeTarget({ PLANNER_BASE_URL: "http://gw/v1" })?.model).toBe("auto");
  });
});

describe("resolvePlannerTarget", () => {
  it("keeps the legacy embeddings fallback but flags it", () => {
    const t = resolvePlannerTarget(embeddingsOnly);
    expect(t?.baseUrl).toBe("https://freellm.example/v1");
    expect(plannerUsesEmbeddingsFallback(embeddingsOnly)).toBe(true);
    expect(plannerUsesEmbeddingsFallback({ ...embeddingsOnly, PLANNER_BASE_URL: "http://gw/v1" })).toBe(false);
  });

  it("is null with nothing configured", () => {
    expect(resolvePlannerTarget({})).toBeNull();
  });
});

describe("extractJson", () => {
  it("returns the last parseable candidate after reasoning prose", () => {
    const text = 'Thinking about {"verdict":"fail"} as an example… final answer:\n{"verdict":"pass","score":0.9}';
    expect(extractJson<{ verdict: string }>(text)?.verdict).toBe("pass");
  });
  it("prefers a fenced block", () => {
    expect(extractJson('```json\n{"a":1}\n``` trailing {"a":2}')).toEqual({ a: 1 });
  });
  it("returns null for null/no JSON", () => {
    expect(extractJson(null)).toBeNull();
    expect(extractJson("no json here")).toBeNull();
  });
});
