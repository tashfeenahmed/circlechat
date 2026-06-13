import { describe, it, expect } from "vitest";
import {
  buildSandboxArgs,
  interpreterFor,
  truncateOutput,
  formatCodeResult,
  type CodeResult,
} from "../lib/code-sandbox.js";

describe("interpreterFor", () => {
  it("maps known languages to a stdin-reading interpreter", () => {
    expect(interpreterFor("python")).toEqual(["python3", "-"]);
    expect(interpreterFor("py")).toEqual(["python3", "-"]);
    expect(interpreterFor("bash")).toEqual(["sh", "-s"]);
  });
  it("returns null for unsupported languages", () => {
    expect(interpreterFor("ruby")).toBeNull();
    expect(interpreterFor("")).toBeNull();
  });
});

describe("buildSandboxArgs hardening", () => {
  const args = buildSandboxArgs("python:3.12-slim", ["python3", "-"], "256m");
  const joined = args.join(" ");

  it("disables the network", () => {
    expect(joined).toContain("--network none");
  });
  it("runs read-only, non-root, with caps dropped and no new privileges", () => {
    expect(joined).toContain("--read-only");
    expect(joined).toContain("-u 65534:65534");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
  });
  it("caps memory (incl. swap), cpu, and pids", () => {
    expect(joined).toContain("--memory 256m");
    expect(joined).toContain("--memory-swap 256m");
    expect(joined).toContain("--cpus 1");
    expect(joined).toContain("--pids-limit 128");
  });
  it("is an --rm container reading the program on stdin", () => {
    expect(args).toContain("--rm");
    expect(args).toContain("-i");
    expect(args[args.length - 2]).toBe("python3");
    expect(args[args.length - 1]).toBe("-");
  });
  it("provides only a small tmpfs scratch, no mounts", () => {
    expect(joined).toContain("--tmpfs /tmp:size=64m");
    expect(joined).not.toContain("-v ");
    expect(joined).not.toContain("--volume");
  });
});

describe("truncateOutput", () => {
  it("leaves short output intact", () => {
    expect(truncateOutput("hello", 100)).toBe("hello");
  });
  it("truncates long output with a marker", () => {
    const out = truncateOutput("x".repeat(50), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("truncated");
  });
});

describe("formatCodeResult", () => {
  const base: CodeResult = { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false };
  it("reports an infra error plainly", () => {
    expect(formatCodeResult("python", { ...base, ok: false, error: "image missing" })).toContain("could not run");
  });
  it("reports a timeout", () => {
    expect(formatCodeResult("python", { ...base, ok: false, timedOut: true })).toContain("TIMED OUT");
  });
  it("includes stdout and stderr", () => {
    const s = formatCodeResult("python", { ...base, stdout: "42", stderr: "warn" });
    expect(s).toContain("stdout:");
    expect(s).toContain("42");
    expect(s).toContain("stderr:");
  });
  it("says (no output) when both streams are empty", () => {
    expect(formatCodeResult("bash", base)).toContain("(no output)");
  });
});
