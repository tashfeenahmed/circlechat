// Server-side guard on agent-authored message bodies. Catches the three
// failure modes we've seen in practice:
//   1. pasted raw tool transcripts (JSON blobs, curl commands, XML-ish
//      tool_use tags)
//   2. the HEARTBEAT_OK sentinel leaking into a channel — it's meant to be
//      the "silence" response, never a visible post
//   3. empty / whitespace-only bodies
//
// Both the MCP post_message route and the action executor call this; a
// violation is logged and the write is refused so the only human-visible
// consequence is that the agent doesn't manage to spam a channel.

export type GuardResult =
  | { ok: true; bodyMd: string }
  | { ok: false; reason: string };

const HEARTBEAT_RE = /^\s*HEARTBEAT_OK\s*$/;
// XML-ish tool-call markup. Match opening AND closing variants of all three
// tag families — Hermes / OpenClaw sometimes emit only the closing `</invoke>`
// at the tail of a botched JSON tool call.
const TOOL_USE_RE = /<\/?tool_use\b|<\/?function_calls\b|<\/?invoke\b/i;
// JSON-shaped tool call, fenced or bare. The fingerprint is a `"tool"` key
// paired with `"input"|"arguments"|"parameters"` somewhere nearby in the same
// JSON blob. Catches both `{ "tool": "...", "input": {...} }` and the
// fenced-then-keyed legacy variant.
const TOOL_CALL_JSON_RE = /\{[\s\S]{0,1200}["“]tool["”]\s*:\s*["“][^"”]+["”][\s\S]{0,1200}["“](?:input|arguments|parameters)["”]\s*:/i;
const CURL_BLOCK_RE = /```[^`]*?\bcurl\s+-[^`]{0,500}```/s;
// The prompt feeds conversation history as `[m_<id>] @handle: body` lines.
// Smaller models occasionally echo that format directly into their reply,
// usually as the start of a runaway repetition loop. A real reply never
// looks like this.
const HISTORY_ECHO_RE = /^\s*\[m_[a-z0-9]{12,}\]\s*@?/i;

// Detect degenerate repetition: same non-trivial line emitted 3+ times. 3B
// models occasionally lock into a loop and emit the same sentence dozens of
// times until they hit the token cap.
function hasRunawayRepetition(s: string): boolean {
  const lines = s.split(/\n+/).map((l) => l.trim()).filter((l) => l.length >= 20);
  if (lines.length < 3) return false;
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const n of counts.values()) if (n >= 3) return true;
  return false;
}
// Bot tokens look like `cc_<32 lowercase alphanumerics>` (see api routes that
// mint them). The literal token is shipped to the agent in its system prompt
// so it can construct curl commands; smaller models occasionally echo it back
// into a chat reply. Scrub-and-post is safer than hard-reject — the secret
// gets stripped and the user still sees the agent's reply.
const BEARER_LEAK_RE = /Authorization:\s*Bearer\s+\S+/gi;
const RAW_BOT_TOKEN_RE = /\bcc_[a-z0-9]{20,}\b/gi;
// Wrapper-only JSON: a body that is nothing but a fenced JSON blob. Allows
// humans (and agents) to legitimately quote a snippet in the middle of prose.
const PURE_JSON_FENCE_RE = /^\s*```(?:json)?\s*\n\s*[\[{][\s\S]*?[\]}]\s*\n\s*```\s*$/;

function scrubSecrets(s: string): string {
  return s
    .replace(BEARER_LEAK_RE, "Authorization: Bearer ***")
    .replace(RAW_BOT_TOKEN_RE, "cc_***");
}

export function checkReplyBody(bodyMd: string): GuardResult {
  const scrubbed = scrubSecrets(bodyMd);
  const trimmed = scrubbed.trim();
  if (!trimmed) return { ok: false, reason: "empty_body" };
  if (HEARTBEAT_RE.test(trimmed)) return { ok: false, reason: "heartbeat_leaked" };
  if (TOOL_USE_RE.test(trimmed)) return { ok: false, reason: "tool_use_markup" };
  if (TOOL_CALL_JSON_RE.test(trimmed)) return { ok: false, reason: "tool_call_json" };
  if (HISTORY_ECHO_RE.test(trimmed)) return { ok: false, reason: "history_format_echo" };
  if (hasRunawayRepetition(trimmed)) return { ok: false, reason: "runaway_repetition" };
  if (CURL_BLOCK_RE.test(trimmed)) return { ok: false, reason: "curl_transcript" };
  if (PURE_JSON_FENCE_RE.test(trimmed) && trimmed.length > 400) {
    return { ok: false, reason: "pure_json_dump" };
  }
  return { ok: true, bodyMd: scrubbed };
}
