// Keyboard chords for the inline message editor (MessageRow). Extracted as a
// pure function so the mapping is testable without a DOM (this package has no
// RTL harness, same reasoning as sendError.ts).
//
// The chords mirror the task comment editor (TaskModal: ⌘/Ctrl+Enter saves,
// Esc cancels) — not the Composer, where plain Enter sends. Plain Enter must
// stay a newline here — Slack/Discord inline editors behave the same way, and
// Shift+Enter has no meaning.

export type EditKeyAction = "save" | "cancel" | null;

export function editKeyAction(key: string, metaOrCtrl: boolean, shiftKey = false): EditKeyAction {
  if (key === "Escape") return "cancel";
  if (key === "Enter" && metaOrCtrl && !shiftKey) return "save";
  return null;
}
