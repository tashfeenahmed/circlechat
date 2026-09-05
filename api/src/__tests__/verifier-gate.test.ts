import { describe, it, expect } from "vitest";
import {
  classifyRenderForGate,
  resolveFailMode,
  decideOnJudgeOutage,
  shouldReuseVerdict,
} from "../lib/task-verifier.js";
import type { RenderObservation } from "../lib/deliverable-render.js";

// The deterministic (fail-CLOSED) tier of the verification gate. It must block
// only on UNAMBIGUOUS browser-load breakage — never on a clean load, never on
// an ambiguous timeout — so a slow or judge-less deploy can't be frozen.

function obs(over: Partial<RenderObservation>): RenderObservation {
  return {
    ok: false,
    entry: "index.html",
    renderedTextLen: 0,
    domBytes: 0,
    consoleErrors: [],
    note: "index.html: 0 visible chars, 0 error line(s)",
    ...over,
  };
}

describe("classifyRenderForGate", () => {
  it("does not block a deliverable that loaded fine", () => {
    const d = classifyRenderForGate(obs({ ok: true, renderedTextLen: 1200 }));
    expect(d.block).toBe(false);
  });

  it("does not block on a render timeout (ambiguous — could be slow)", () => {
    const d = classifyRenderForGate(obs({ ok: false, note: "render timed out after 8000ms" }));
    expect(d.block).toBe(false);
  });

  it("blocks a page that rendered blank", () => {
    const d = classifyRenderForGate(obs({ ok: false, renderedTextLen: 0 }));
    expect(d.block).toBe(true);
    if (d.block) expect(d.reason).toContain("blank");
  });

  it("blocks a page that threw load/JS errors", () => {
    const d = classifyRenderForGate(
      obs({ ok: false, renderedTextLen: 300, consoleErrors: ["net::ERR_FILE_NOT_FOUND app.js", "Uncaught ReferenceError: x"] }),
    );
    expect(d.block).toBe(true);
    if (d.block) {
      expect(d.reason).toContain("2 load/JS error");
      expect(d.reason).toContain("net::ERR_FILE_NOT_FOUND");
    }
  });
});

// What a judge OUTAGE does to the done-flip is an operator choice. The default
// must stay fail-open (a gateway hiccup never freezes the board), `closed`
// blocks, `hold` blocks and asks the caller to leave one comment.
describe("VERIFY_FAIL_MODE", () => {
  it("defaults to open on unset/garbage", () => {
    expect(resolveFailMode(undefined)).toBe("open");
    expect(resolveFailMode("")).toBe("open");
    expect(resolveFailMode("banana")).toBe("open");
  });
  it("parses closed/hold case-insensitively", () => {
    expect(resolveFailMode("CLOSED")).toBe("closed");
    expect(resolveFailMode(" hold ")).toBe("hold");
  });
  it("open allows, closed blocks silently, hold blocks and comments", () => {
    expect(decideOnJudgeOutage("open")).toEqual({ block: false, comment: false });
    expect(decideOnJudgeOutage("closed")).toEqual({ block: true, comment: false });
    expect(decideOnJudgeOutage("hold")).toEqual({ block: true, comment: true });
  });
});

// Re-judging the SAME artifact on every retried flip is what hammered the
// gateway into "unreachable". Reuse a fresh real verdict; never reuse an outage.
describe("shouldReuseVerdict", () => {
  const now = 1_000_000_000;
  const row = (over: Partial<{ artifactId: string | null; verdict: string; createdAt: Date }>) => ({
    artifactId: "art_1",
    verdict: "fail",
    createdAt: new Date(now - 60_000),
    ...over,
  });
  it("reuses a recent pass/fail on the same artifact", () => {
    expect(shouldReuseVerdict(row({ verdict: "fail" }), "art_1", now, 600_000)).toBe(true);
    expect(shouldReuseVerdict(row({ verdict: "pass" }), "art_1", now, 600_000)).toBe(true);
  });
  it("does not reuse for a different artifact, an error row, or a stale row", () => {
    expect(shouldReuseVerdict(row({}), "art_2", now, 600_000)).toBe(false);
    expect(shouldReuseVerdict(row({ verdict: "error" }), "art_1", now, 600_000)).toBe(false);
    expect(shouldReuseVerdict(row({ createdAt: new Date(now - 601_000) }), "art_1", now, 600_000)).toBe(false);
    expect(shouldReuseVerdict(null, "art_1", now, 600_000)).toBe(false);
    expect(shouldReuseVerdict(row({ artifactId: null }), "art_1", now, 600_000)).toBe(false);
  });
});
