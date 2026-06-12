import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyBudget,
  estimateRunCost,
  monthStartUtc,
  warnedThisMonth,
  WARN_RATIO,
} from "../lib/budgets.js";

describe("classifyBudget", () => {
  it("treats null/zero/negative budgets as unlimited", () => {
    expect(classifyBudget(999, null)).toBe("ok");
    expect(classifyBudget(999, undefined)).toBe("ok");
    expect(classifyBudget(999, 0)).toBe("ok");
    expect(classifyBudget(999, -5)).toBe("ok");
  });

  it("is ok below the warn threshold", () => {
    expect(classifyBudget(0, 10)).toBe("ok");
    expect(classifyBudget(7.99, 10)).toBe("ok");
  });

  it("warns from exactly 80% up to the cap", () => {
    expect(classifyBudget(10 * WARN_RATIO, 10)).toBe("warn");
    expect(classifyBudget(9.99, 10)).toBe("warn");
  });

  it("hard-stops at and beyond the cap", () => {
    expect(classifyBudget(10, 10)).toBe("hard_stop");
    expect(classifyBudget(15, 10)).toBe("hard_stop");
  });
});

describe("estimateRunCost", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.rate = process.env.CC_COST_PER_MTOK_USD;
    saved.mult = process.env.CC_COST_RUN_MULTIPLIER;
  });
  afterEach(() => {
    if (saved.rate === undefined) delete process.env.CC_COST_PER_MTOK_USD;
    else process.env.CC_COST_PER_MTOK_USD = saved.rate;
    if (saved.mult === undefined) delete process.env.CC_COST_RUN_MULTIPLIER;
    else process.env.CC_COST_RUN_MULTIPLIER = saved.mult;
  });

  it("derives tokens from chars/4 times the loop multiplier", () => {
    process.env.CC_COST_PER_MTOK_USD = "1";
    process.env.CC_COST_RUN_MULTIPLIER = "1";
    const { tokensEst, costUsd } = estimateRunCost(4000, 4000);
    expect(tokensEst).toBe(2000);
    expect(costUsd).toBeCloseTo(0.002);
  });

  it("applies the default 3x multiplier", () => {
    delete process.env.CC_COST_RUN_MULTIPLIER;
    process.env.CC_COST_PER_MTOK_USD = "1";
    expect(estimateRunCost(4000, 0).tokensEst).toBe(3000);
  });

  it("survives garbage env values with defaults", () => {
    process.env.CC_COST_PER_MTOK_USD = "banana";
    process.env.CC_COST_RUN_MULTIPLIER = "-2";
    const { tokensEst, costUsd } = estimateRunCost(4000, 0);
    expect(tokensEst).toBe(3000); // default multiplier 3
    expect(costUsd).toBeCloseTo((3000 / 1_000_000) * 0.5); // default rate 0.5
  });

  it("never returns negative or NaN", () => {
    const { tokensEst, costUsd } = estimateRunCost(0, 0);
    expect(tokensEst).toBe(0);
    expect(costUsd).toBe(0);
  });
});

describe("month windows", () => {
  it("monthStartUtc returns the first of the month at 00:00 UTC", () => {
    const d = monthStartUtc(new Date("2026-06-12T15:30:00Z"));
    expect(d.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("warnedThisMonth is true only for timestamps inside the current month", () => {
    const now = new Date("2026-06-12T00:00:00Z");
    expect(warnedThisMonth(new Date("2026-06-02T00:00:00Z"), now)).toBe(true);
    expect(warnedThisMonth(new Date("2026-05-31T23:59:59Z"), now)).toBe(false);
    expect(warnedThisMonth(null, now)).toBe(false);
    expect(warnedThisMonth(undefined, now)).toBe(false);
  });
});
