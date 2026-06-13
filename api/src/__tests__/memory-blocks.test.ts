import { describe, it, expect } from "vitest";
import { applyBlockEdit } from "../lib/memory-blocks.js";

describe("applyBlockEdit", () => {
  it("appends a line to an empty block", () => {
    const r = applyBlockEdit("", 2000, { op: "append", text: "shipped the landing page" });
    expect(r).toEqual({ value: "shipped the landing page" });
  });

  it("appends a line to a non-empty block on a new line", () => {
    const r = applyBlockEdit("line one", 2000, { op: "append", text: "line two" });
    expect(r).toEqual({ value: "line one\nline two" });
  });

  it("rejects an empty append", () => {
    const r = applyBlockEdit("x", 2000, { op: "append", text: "   " });
    expect("error" in r).toBe(true);
  });

  it("rethink replaces the whole block", () => {
    const r = applyBlockEdit("old sprawling content", 2000, { op: "rethink", value: "tidy summary" });
    expect(r).toEqual({ value: "tidy summary" });
  });

  it("blocks an edit that exceeds the char limit, with a trim hint", () => {
    const r = applyBlockEdit("", 50, { op: "rethink", value: "x".repeat(80) });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toContain("50-char");
      expect(r.error).toContain("memory_rethink");
    }
  });

  it("append that would overflow is rejected (not silently truncated)", () => {
    const r = applyBlockEdit("x".repeat(45), 50, { op: "append", text: "more text here" });
    expect("error" in r).toBe(true);
  });

  it("trims surrounding whitespace on rethink", () => {
    const r = applyBlockEdit("a", 2000, { op: "rethink", value: "  spaced  " });
    expect(r).toEqual({ value: "spaced" });
  });
});
