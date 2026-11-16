// SPDX-License-Identifier: AGPL-3.0-only
// Some models, local ones especially, sometimes write a tool call into their reply
// instead of making it. Nothing runs, and the chat would get a block of markup. This
// spots the common shapes so the runtime can ask once more instead of posting it.
// (Idea from Borderux's CircleChat fork, which met it with Qwen models.)

// Markup that only appears when a model writes out a call in its own tool format.
const MARKUP = [
  /<tool_call>/i, // Hermes / Qwen
  /<function=[\w.:-]+>/i, // Qwen's parameter form
  /<function_calls>|<invoke name=/i, // Anthropic-style XML
  /\[TOOL_CALLS\]/, // Mistral
  /<\|python_tag\|>|<\|tool_call\|>/, // Llama and others
];

/** A JSON tool call, bare or in a code fence: {"name": ..., "arguments"|"parameters"|"input": {...}}. */
function jsonCall(text: string): boolean {
  const fenced = text.match(/^```(?:json|tool_call)?\s*\n([\s\S]*?)\n```$/);
  const body = (fenced ? fenced[1] : text).trim();
  if (!/^[[{]/.test(body)) return false;
  try {
    const v = JSON.parse(body);
    const calls = Array.isArray(v) ? v : [v];
    return calls.length > 0 && calls.every((c) => c && typeof c === "object" && typeof (c.name ?? c.tool ?? c.function?.name) === "string" && (c.arguments ?? c.parameters ?? c.input ?? c.function?.arguments) !== undefined);
  } catch {
    return false;
  }
}

/**
 * True when a reply is a tool call written as text rather than an answer.
 * Markup counts anywhere outside a fenced code block; JSON only when it is the whole reply
 * (or its last paragraph), so a reply that shows example JSON to a person is left alone.
 */
export function looksLikeTextToolCall(reply: string): boolean {
  const text = reply.trim();
  if (!text) return false;
  const outsideFences = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  if (MARKUP.some((re) => re.test(outsideFences))) return true;
  if (jsonCall(text)) return true;
  const last = text.split(/\n\s*\n/).pop() ?? "";
  return last !== text && jsonCall(last.trim());
}

export const TOOL_CALL_REMINDER =
  "Your last reply wrote a tool call out as text, so nothing ran and nobody saw an answer. " +
  "Call the tool through tool calling instead, then reply to the chat in plain words. " +
  "If you don't need a tool, just answer in plain words.";
