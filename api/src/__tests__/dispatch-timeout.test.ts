import { describe, expect, it } from "vitest";
import { dispatchTimeoutMs } from "../lib/config.js";

describe("dispatchTimeoutMs", () => {
  it("defaults to the bridge default plus a minute", () => {
    expect(dispatchTimeoutMs({})).toBe((480 + 60) * 1000);
  });
  it("tracks HERMES_TIMEOUT when set", () => {
    expect(dispatchTimeoutMs({ HERMES_TIMEOUT: "900" })).toBe(960_000);
  });
  it("ignores empty or junk HERMES_TIMEOUT", () => {
    expect(dispatchTimeoutMs({ HERMES_TIMEOUT: "" })).toBe(540_000);
    expect(dispatchTimeoutMs({ HERMES_TIMEOUT: "abc" })).toBe(540_000);
  });
  it("lets CC_DISPATCH_TIMEOUT_MS override", () => {
    expect(dispatchTimeoutMs({ CC_DISPATCH_TIMEOUT_MS: "1200000", HERMES_TIMEOUT: "900" })).toBe(1_200_000);
  });
});
