import { describe, it, expect } from "vitest";
import { acceptJanitorOutput } from "../lib/memory-janitor.js";

describe("acceptJanitorOutput", () => {
  it("accepts a normal rewrite", () => {
    const r = acceptJanitorOutput("Project state: landing page shipped. Rachel on copy.", 3000);
    expect(r.accept).toBe(true);
    if (r.accept) expect(r.value).toContain("landing page");
  });

  it("rejects the NO_CHANGE sentinel", () => {
    expect(acceptJanitorOutput("NO_CHANGE", 3000).accept).toBe(false);
    expect(acceptJanitorOutput("  no_change  ", 3000).accept).toBe(false);
  });

  it("rejects empty output", () => {
    expect(acceptJanitorOutput("   ", 3000).accept).toBe(false);
  });

  it("truncates output over the char limit rather than rejecting it", () => {
    const r = acceptJanitorOutput("x".repeat(100), 50);
    expect(r.accept).toBe(true);
    if (r.accept) expect(r.value.length).toBe(50);
  });
});
