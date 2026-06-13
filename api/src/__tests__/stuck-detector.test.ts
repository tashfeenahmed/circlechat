import { describe, it, expect } from "vitest";
import { normalizeRunSignature, detectStuck } from "../lib/stuck-detector.js";

describe("normalizeRunSignature", () => {
  it("strips volatile ids so the same action on different ids matches", () => {
    const a = normalizeRunSignature(["update_task task_abc123"], []);
    const b = normalizeRunSignature(["update_task task_zzz999"], []);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it("returns null for an idle run (no actions, no errors)", () => {
    expect(normalizeRunSignature([], [])).toBeNull();
    expect(normalizeRunSignature(null, null)).toBeNull();
  });

  it("is order-independent (set semantics)", () => {
    const a = normalizeRunSignature(["post_message c_1", "update_task task_1"], []);
    const b = normalizeRunSignature(["update_task task_2", "post_message c_2"], []);
    expect(a).toBe(b);
  });

  it("folds error reasons into the signature", () => {
    const sig = normalizeRunSignature([], ["post_message rejected: cot_leak. Some hint"]);
    expect(sig).toContain("rejected");
  });
});

describe("detectStuck", () => {
  const S = (s: string) => s; // readability

  it("flags 3 identical runs in a row (repeat)", () => {
    const r = detectStuck([S("a"), S("a"), S("a")]);
    expect(r.stuck).toBe(true);
    if (r.stuck) expect(r.pattern).toBe("repeat");
  });

  it("does not flag only 2 identical runs", () => {
    expect(detectStuck([S("a"), S("a")]).stuck).toBe(false);
  });

  it("flags A-B-A-B alternation (which a same-message check misses)", () => {
    const r = detectStuck([S("a"), S("b"), S("a"), S("b")]);
    expect(r.stuck).toBe(true);
    if (r.stuck) expect(r.pattern).toBe("alternate");
  });

  it("does not flag genuine varied progress", () => {
    expect(detectStuck([S("a"), S("b"), S("c"), S("d")]).stuck).toBe(false);
  });

  it("idle runs (null) break a run of repeats", () => {
    // post X, post X, idle, post X — not 3 consecutive identical.
    expect(detectStuck([S("a"), S("a"), null, S("a")]).stuck).toBe(false);
  });

  it("null signatures never count as a loop on their own", () => {
    expect(detectStuck([null, null, null]).stuck).toBe(false);
    expect(detectStuck([null, null, null, null]).stuck).toBe(false);
  });

  it("only the most recent runs matter (earlier varied runs don't save it)", () => {
    const r = detectStuck([S("x"), S("y"), S("a"), S("a"), S("a")]);
    expect(r.stuck).toBe(true);
  });
});
