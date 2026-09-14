import { describe, it, expect } from "vitest";
import { isTrivialInput, meaningfulText } from "../lib/trivial-input.js";

// In a three-hour live window, the ONLY model work the whole deployment did was
// four agents composing replies to a single 👏.

describe("meaningfulText", () => {
  it("strips emoji down to nothing", () => {
    expect(meaningfulText("👏")).toBe("");
    expect(meaningfulText("👏👏👏")).toBe("");
    expect(meaningfulText("🎉 🚀 ✅")).toBe("");
  });

  it("keeps the words and drops the decoration", () => {
    expect(meaningfulText("**ship it** 🚀")).toBe("ship it");
    expect(meaningfulText("> quoted thing")).toBe("quoted thing");
  });
});

describe("isTrivialInput", () => {
  it("a bare clap does not wake three agents", () => {
    expect(isTrivialInput("👏")).toBe(true);
    expect(isTrivialInput("👍")).toBe(true);
    expect(isTrivialInput("🎉🎉")).toBe(true);
  });

  it("acknowledgements are trivial however they are punctuated", () => {
    for (const s of ["ok", "OK!", "thanks", "Thanks!!", "ty", "+1", "nice 👌", "lgtm", "sounds good"]) {
      expect(isTrivialInput(s), s).toBe(true);
    }
  });

  it("empty and whitespace-only posts are trivial", () => {
    expect(isTrivialInput("")).toBe(true);
    expect(isTrivialInput("   \n ")).toBe(true);
  });

  it("a real instruction is never trivial", () => {
    expect(isTrivialInput("can you ship the landing page today?")).toBe(false);
    expect(isTrivialInput("the deploy is broken, rollback")).toBe(false);
  });

  it("an @mention is never trivial, however short", () => {
    expect(isTrivialInput("@ben go")).toBe(false);
    expect(isTrivialInput("@ben 👏")).toBe(false);
  });

  it("a link or a code fence is never trivial", () => {
    expect(isTrivialInput("https://x.co/a")).toBe(false);
    expect(isTrivialInput("```\nx=1\n```")).toBe(false);
  });

  it("a post carrying files is never trivial even with an empty body", () => {
    expect(isTrivialInput("", { hasAttachments: true })).toBe(false);
    expect(isTrivialInput("👀", { hasAttachments: true })).toBe(false);
  });

  it("short-but-meaningful sits above the character floor", () => {
    // 10 chars is the default floor; "ship it now" clears it.
    expect(isTrivialInput("ship it now")).toBe(false);
    expect(isTrivialInput("do it")).toBe(true);
  });
});
