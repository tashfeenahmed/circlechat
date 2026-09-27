import { describe, expect, it } from "vitest";
import { editKeyAction } from "./editKeys";

describe("editKeyAction", () => {
  it("saves on Cmd/Ctrl+Enter (both modifiers, no Shift)", () => {
    expect(editKeyAction("Enter", true)).toBe("save");
    expect(editKeyAction("Enter", true, false)).toBe("save");
  });

  it("keeps plain and Shift+Enter as newlines", () => {
    expect(editKeyAction("Enter", false)).toBeNull();
    expect(editKeyAction("Enter", false, true)).toBeNull();
    // A modified-but-not-submitting chord still types a newline rather than
    // doing nothing confusing — only Cmd/Ctrl+Enter saves.
    expect(editKeyAction("Enter", true, true)).toBeNull();
  });

  it("cancels on Escape regardless of modifiers", () => {
    expect(editKeyAction("Escape", false)).toBe("cancel");
    expect(editKeyAction("Escape", true)).toBe("cancel");
  });

  it("ignores every other key", () => {
    expect(editKeyAction("a", true)).toBeNull();
    expect(editKeyAction("Backspace", false)).toBeNull();
  });
});
