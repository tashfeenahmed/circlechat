import { describe, it, expect } from "vitest";
import { classifyRenderForGate } from "../lib/task-verifier.js";
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
