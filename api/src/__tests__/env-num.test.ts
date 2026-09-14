import { describe, it, expect, afterEach } from "vitest";
import { coerceInt, coerceNum, envInt, envNum } from "../lib/env.js";
import { retentionWindows } from "../lib/retention.js";
import { dispatchTimeoutMs } from "../lib/config.js";

// compose.yml declares every tunable as `VAR: ${VAR:-}`, so a deployment that
// sets nothing hands the container an EMPTY STRING, not an absent variable.
// `Number(process.env.X ?? default)` then yields 0, because `??` does not fall
// back on "" — which is how GOAL_PARK_AFTER_MS became 0 on live and parked
// every goal two minutes after a deploy. "" and undefined must behave the same.

const KEY = "CC_TEST_ENV_NUM";
afterEach(() => {
  delete process.env[KEY];
});

describe("an empty environment variable means unset", () => {
  it("falls back for undefined, empty and whitespace alike", () => {
    for (const raw of [undefined, "", "   ", "\t\n"]) {
      expect(coerceNum(raw, 900_000)).toBe(900_000);
      expect(coerceInt(raw, 3)).toBe(3);
    }
  });

  it("reads the real thing when the operator actually sets one", () => {
    expect(coerceNum("1500", 900_000)).toBe(1500);
    expect(coerceNum("0.75", 0.6)).toBe(0.75);
    expect(coerceInt("7.9", 3)).toBe(7);
  });

  it("still honours an explicit zero where the range allows it", () => {
    // AMBIENT_HUMAN_ACTIVE_MS=0 is how an operator turns that check off.
    expect(coerceNum("0", 86_400_000, { min: 0 })).toBe(0);
    // …and a zero is rejected where zero is nonsense.
    expect(coerceNum("0", 900_000, { min: 1 })).toBe(900_000);
  });

  it("falls back for junk and out-of-range values", () => {
    expect(coerceNum("abc", 12)).toBe(12);
    expect(coerceNum("NaN", 12)).toBe(12);
    expect(coerceNum("Infinity", 12)).toBe(12);
    expect(coerceNum("-5", 12, { min: 0 })).toBe(12);
    expect(coerceNum("1.5", 0.6, { min: 0, max: 1 })).toBe(0.6);
  });

  it("reads process.env through envNum/envInt", () => {
    expect(envNum(KEY, 42)).toBe(42);
    process.env[KEY] = "";
    expect(envNum(KEY, 42)).toBe(42);
    expect(envInt(KEY, 42)).toBe(42);
    process.env[KEY] = "17";
    expect(envNum(KEY, 42)).toBe(17);
    expect(envInt(KEY, 42)).toBe(17);
  });

  it("accepts an injected environment", () => {
    expect(envNum("X", 5, { env: { X: "" } })).toBe(5);
    expect(envNum("X", 5, { env: { X: "9" } })).toBe(9);
  });
});

describe("the call sites the empty strings actually broke", () => {
  it("retention windows ignore empty declarations", () => {
    const empty = retentionWindows({
      CC_NOTIFICATION_READ_RETENTION_DAYS: "",
      CC_NOTIFICATION_UNREAD_RETENTION_DAYS: "",
      CC_NOTIFICATION_MAX_PER_MEMBER: "",
      CC_RUN_CONTEXT_RETENTION_DAYS: "",
      CC_RUN_RETENTION_DAYS: "",
      CC_DONE_ARCHIVE_DAYS: "",
    });
    expect(empty).toEqual(retentionWindows({}));
    expect(empty.doneArchiveDays).toBe(7);
  });

  it("the dispatch timeout ignores empty declarations", () => {
    expect(dispatchTimeoutMs({ CC_DISPATCH_TIMEOUT_MS: "", HERMES_TIMEOUT: "" })).toBe(
      dispatchTimeoutMs({}),
    );
    expect(dispatchTimeoutMs({ CC_DISPATCH_TIMEOUT_MS: "", HERMES_TIMEOUT: "900" })).toBe(960_000);
    expect(dispatchTimeoutMs({ CC_DISPATCH_TIMEOUT_MS: "120000" })).toBe(120_000);
  });
});
