import { describe, it, expect } from "vitest";
import { acceptJanitorOutput, janitorEnabled } from "../lib/memory-janitor.js";

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

// The janitor never ran on live: it required CC_MEMORY_JANITOR=on, and that var
// was missing from the compose `environment:` allowlist, so setting it in .env
// could not reach the worker container. memory_blocks had not been touched
// since 19 August. It is now on wherever a planner endpoint is configured.
describe("janitorEnabled", () => {
  const withPlanner = { PLANNER_BASE_URL: "https://gw.example/v1" };

  it("is on by default once a planner endpoint exists", () => {
    expect(janitorEnabled({ ...withPlanner })).toBe(true);
  });

  it("stays on for the legacy explicit opt-in", () => {
    expect(janitorEnabled({ ...withPlanner, CC_MEMORY_JANITOR: "on" })).toBe(true);
  });

  it("is off when explicitly disabled, in any spelling", () => {
    for (const v of ["off", "OFF", "0", "false", "no", " off "]) {
      expect(janitorEnabled({ ...withPlanner, CC_MEMORY_JANITOR: v }), v).toBe(false);
    }
  });

  it("stays off without a planner endpoint — there is nothing to call", () => {
    expect(janitorEnabled({})).toBe(false);
    expect(janitorEnabled({ CC_MEMORY_JANITOR: "on" })).toBe(false);
  });
});
