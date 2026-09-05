import { describe, it, expect, beforeAll } from "vitest";

// The bridge is plain ESM (.mjs) with no type declarations; import it
// dynamically in import-only mode so it never opens sockets.
type Bridge = {
  extractReply: (raw: string) => string;
  stripRuntimeNoise: (s: string) => string;
  truncateAtBoundary: (s: string, max: number) => string;
  leadOf: (s: string, max: number) => string;
  isEntrypointNoise: (line: string) => boolean;
  CHAT_BODY_MAX: number;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

const BANNER = "⚠️  Reached maximum iterations (20). Requesting summary...";
const TOOL_FAIL =
  '⚠ Could not execute tool(s): "target": value "files\n@@ARG_END" not in enum ["messages", "tasks", "members"]';

describe("bridge extractReply — runtime noise", () => {
  it("drops the runaway-iterations banner line and keeps the wrap-up", () => {
    const out = bridge.extractReply(`${BANNER}\nRelay verified at https://relay.test/live.m3u8 — 3/3 streams up.`);
    expect(out).not.toMatch(/Reached maximum iterations/);
    expect(out).toContain("Relay verified");
  });

  it("drops the multi-line 'Could not execute tool(s)' paragraph", () => {
    const out = bridge.extractReply(`${TOOL_FAIL}\n\nHere is the file list you asked for: a.md, b.md.`);
    expect(out).not.toMatch(/Could not execute|@@ARG_END|not in enum/);
    expect(out).toContain("file list");
  });

  it("returns empty when the stream is only the banner", () => {
    expect(bridge.extractReply(BANNER)).toBe("");
  });

  it("treats banner/parser-debris lines as entrypoint noise", () => {
    expect(bridge.isEntrypointNoise(BANNER)).toBe(true);
    expect(bridge.isEntrypointNoise("Requesting summary...")).toBe(true);
    expect(bridge.isEntrypointNoise('@@ARG_END" not in enum')).toBe(true);
    expect(bridge.isEntrypointNoise("Verified the relay is live.")).toBe(false);
  });
});

describe("bridge truncateAtBoundary", () => {
  it("returns short text unchanged", () => {
    expect(bridge.truncateAtBoundary("short", 100)).toBe("short");
  });

  it("cuts at a paragraph break when one sits past half the budget", () => {
    const p1 = "First paragraph. ".repeat(10).trim();
    const p2 = "Second paragraph. ".repeat(10).trim();
    const text = `${p1}\n\n${p2}`;
    const out = bridge.truncateAtBoundary(text, p1.length + 40);
    expect(out).toBe(p1);
  });

  it("cuts at a sentence end, never mid-word, when there is no paragraph break", () => {
    const text = "Alpha is done. Beta is next in the queue. Gamma still failing on the manifest path check.";
    const out = bridge.truncateAtBoundary(text, 60);
    expect(out).toBe("Alpha is done. Beta is next in the queue.");
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it("never exceeds the cap", () => {
    const text = "x".repeat(5000);
    expect(bridge.truncateAtBoundary(text, 2000).length).toBeLessThanOrEqual(2000);
  });

  it("no longer hard-slices the fallback reply at 2000 chars", () => {
    const sentence = "The relay is verified live and the manifest resolves. ";
    const long = sentence.repeat(60); // ~3300 chars
    const out = bridge.extractReply(long);
    expect(out.length).toBeGreaterThan(2000);
    expect(out.endsWith(".")).toBe(true);
  });
});

describe("bridge leadOf", () => {
  it("takes the first paragraph, capped at a boundary", () => {
    const out = bridge.leadOf("Backend is live on port 3000. Health returns 200.\n\nDetails: lots more.", 400);
    expect(out).toBe("Backend is live on port 3000. Health returns 200.");
  });
});

describe("bridge isEntrypointNoise — gateway boot banner", () => {
  it("treats every banner line as noise", () => {
    const m = bridge;
    for (const line of [
      "┌──────────────────────────────┐",
      "│ ⚕ Hermes Gateway Starting... │",
      "│ Messaging platforms + cron scheduler │",
      "│ Press Ctrl+C to stop │",
      "└──────────────────────────────┘",
    ]) expect(m.isEntrypointNoise(line)).toBe(true);
    expect(m.isEntrypointNoise("Backend verified on port 3000.")).toBe(false);
  });
});

describe("bridge stripRuntimeNoise — file-mutation verifier notice", () => {
  it("drops the header and its bullets, keeps the reply", () => {
    const text = "Backend is live on port 3000.\n\n⚠️ File-mutation verifier: 1 file(s) were NOT modified this turn despite any wording above.\n  • `/workspace/tmp/x.py` — [write_file] Write denied: outside HERMES_WRITE_SAFE_ROOT (/opt/data). Unset the variable or add this path's directory prefix.";
    const out = bridge.stripRuntimeNoise(text);
    expect(out).toBe("Backend is live on port 3000.");
  });
});
