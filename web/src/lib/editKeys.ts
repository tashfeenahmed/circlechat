// Keyboard chords for the inline message editor (MessageRow). Extracted as a
// pure function so the mapping is testable without a DOM (this package has no
// RTL harness, same reasoning as sendError.ts).
//
// The chords mirror the Composer: ⌘/Ctrl+Enter is the universal "submit"
// binding, Escape is cancel. Plain Enter must stay a newline — Slack/Discord
// inline editors behave the same way, and Shift+Enter has no meaning here.

export type EditKeyAction = "save" | "cancel" | null;

export function editKeyAction(key: string, metaOrCtrl: boolean, shiftKey = false): EditKeyAction {
  if (key === "Escape") return "cancel";
  if (key === "Enter" && metaOrCtrl && !shiftKey) return "save";
  return null;
}
