import { describe, it, expect, afterEach } from "vitest";
import {
  judgeMaxTokens,
  judgeReasoningEffort,
  maxJudgesPerSet,
  judgeTimeoutMs,
  decideOnRejudgeCap,
  shouldReuseVerdict,
} from "../lib/task-verifier.js";
import { resolveJudgeTarget, resolvePlannerTarget } from "../lib/completion.js";

// Judge configuration. On live every VERIFY_JUDGE_* var was empty, so the judge
// silently inherited PLANNER_BASE_URL with model "auto" and 541 of 1,239
// verifications recorded "judge unreachable". Probing that gateway showed the
// real cause of the unparseable replies: reasoning models burn an 800-token
// budget on their chain of thought before emitting the JSON verdict.

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("judgeMaxTokens", () => {
  it("defaults well above the old 800 so a reasoning model can still reach the JSON", () => {
    expect(judgeMaxTokens({})).toBe(3000);
    expect(judgeMaxTokens({})).toBeGreaterThan(800);
  });

  it("honours VERIFY_JUDGE_MAX_TOKENS and ignores garbage", () => {
    expect(judgeMaxTokens({ VERIFY_JUDGE_MAX_TOKENS: "4096" })).toBe(4096);
    expect(judgeMaxTokens({ VERIFY_JUDGE_MAX_TOKENS: "nope" })).toBe(3000);
    expect(judgeMaxTokens({ VERIFY_JUDGE_MAX_TOKENS: "0" })).toBe(3000);
  });
});

describe("judgeReasoningEffort", () => {
  it("asks for minimal reasoning by default — a rubric verdict needs none", () => {
    expect(judgeReasoningEffort({})).toBe("minimal");
  });

  it("can be turned off entirely with an explicit empty value", () => {
    expect(judgeReasoningEffort({ VERIFY_JUDGE_REASONING_EFFORT: "" })).toBe("");
    expect(judgeReasoningEffort({ VERIFY_JUDGE_REASONING_EFFORT: "  " })).toBe("");
  });

  it("passes any other effort level through", () => {
    expect(judgeReasoningEffort({ VERIFY_JUDGE_REASONING_EFFORT: "low" })).toBe("low");
  });
});

describe("maxJudgesPerSet", () => {
  it("caps re-judging of an unchanged artifact set at 3 by default", () => {
    expect(maxJudgesPerSet({})).toBe(3);
  });

  it("is operator-tunable", () => {
    expect(maxJudgesPerSet({ VERIFY_MAX_JUDGES_PER_SET: "5" })).toBe(5);
    expect(maxJudgesPerSet({ VERIFY_MAX_JUDGES_PER_SET: "-1" })).toBe(3);
  });
});

describe("judge target resolution", () => {
  it("inherits the planner endpoint when VERIFY_JUDGE_BASE_URL is unset — the live shape", () => {
    const env = { PLANNER_BASE_URL: "https://gw.example/v1", PLANNER_API_KEY: "k" };
    const t = resolveJudgeTarget(env)!;
    expect(t.baseUrl).toBe("https://gw.example/v1");
    expect(t.model).toBe("auto"); // exactly the drift the startup log now names
  });

  it("prefers an explicitly pinned judge endpoint and model", () => {
    const t = resolveJudgeTarget({
      PLANNER_BASE_URL: "https://gw.example/v1",
      VERIFY_JUDGE_BASE_URL: "https://judge.example/v1",
      VERIFY_JUDGE_MODEL: "gemini-2.5-flash",
    })!;
    expect(t.baseUrl).toBe("https://judge.example/v1");
    expect(t.model).toBe("gemini-2.5-flash");
  });

  it("lets PLANNER_MODEL pin the judge without pinning a separate endpoint", () => {
    const t = resolveJudgeTarget({ PLANNER_BASE_URL: "https://gw.example/v1", PLANNER_MODEL: "gemini-2.5-flash" })!;
    expect(t.model).toBe("gemini-2.5-flash");
  });

  it("never resolves from an embeddings-only deployment", () => {
    expect(resolveJudgeTarget({ EMBEDDINGS_BASE_URL: "https://emb.example/v1" })).toBeNull();
    // ...while the planner still may, by design (legacy deployments).
    expect(resolvePlannerTarget({ EMBEDDINGS_BASE_URL: "https://emb.example/v1" })).not.toBeNull();
  });
});

describe("judgeTimeoutMs", () => {
  it("leaves a slow reasoning model room to answer", () => {
    expect(judgeTimeoutMs({})).toBe(180_000);
  });
});

// The re-judge loop. VERIFY_REJUDGE_MIN_MS was unset on live, and because an
// `error` row is deliberately never reused, every heartbeat re-called a dead
// judge: one task accumulated 125 verification rows, another 4 in 3 minutes.
describe("decideOnRejudgeCap", () => {
  it("calls the judge while the set is under the cap", () => {
    expect(decideOnRejudgeCap({ total: 0, lastVerdict: null })).toEqual({ judge: true });
    expect(decideOnRejudgeCap({ total: 2, lastVerdict: "error" })).toEqual({ judge: true });
  });

  it("stops calling the judge once an UNCHANGED set has been judged enough", () => {
    expect(decideOnRejudgeCap({ total: 3, lastVerdict: "error" }).judge).toBe(false);
    expect(decideOnRejudgeCap({ total: 125, lastVerdict: "error" }).judge).toBe(false);
  });

  it("answers from the real verdict it already has rather than re-posting", () => {
    expect(decideOnRejudgeCap({ total: 3, lastVerdict: "pass" })).toEqual({ judge: false, outcome: null });
    expect(decideOnRejudgeCap({ total: 3, lastVerdict: "fail" })).toEqual({
      judge: false,
      outcome: "verification_failed",
    });
  });

  it("leaves the card to VERIFY_FAIL_MODE when the set only ever produced outages", () => {
    // With VERIFY_FAIL_MODE=hold (the live setting) the caller blocks the flip
    // and posts ONE deduped comment — the card waits for a human, it does not
    // collect a comment per heartbeat.
    expect(decideOnRejudgeCap({ total: 3, lastVerdict: null })).toEqual({
      judge: false,
      outcome: "judge_unavailable",
    });
    expect(decideOnRejudgeCap({ total: 4, lastVerdict: "error" }).judge).toBe(false);
  });

  it("honours an operator-raised cap", () => {
    expect(decideOnRejudgeCap({ total: 3, lastVerdict: "error" }, 10)).toEqual({ judge: true });
  });
});

// The 10-minute reuse window is the FIRST line of defence: the same artifact
// with a recent real verdict never reaches the judge at all.
describe("shouldReuseVerdict", () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const row = (over: Partial<{ artifactId: string; verdict: string; createdAt: Date }> = {}) => ({
    artifactId: "art_1",
    verdict: "fail",
    createdAt: new Date(now - 60_000),
    ...over,
  });

  it("defaults to a 10-minute floor even with VERIFY_REJUDGE_MIN_MS unset", () => {
    delete process.env.VERIFY_REJUDGE_MIN_MS;
    expect(shouldReuseVerdict(row(), "art_1", now)).toBe(true);
    expect(shouldReuseVerdict(row({ createdAt: new Date(now - 11 * 60_000) }), "art_1", now)).toBe(false);
  });

  it("never reuses an outage row — that is what the cap above is for", () => {
    expect(shouldReuseVerdict(row({ verdict: "error" }), "art_1", now)).toBe(false);
  });

  it("never reuses across a different deliverable", () => {
    expect(shouldReuseVerdict(row(), "art_2", now)).toBe(false);
    expect(shouldReuseVerdict(null, "art_1", now)).toBe(false);
  });
});
