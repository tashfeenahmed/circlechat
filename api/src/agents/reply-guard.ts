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

// startsWith rather than exact match: a valid <actions> block gets stripped
// before this check runs, so anything still starting with HEARTBEAT_OK is
// either a bare silence sentinel or a malformed actions block that the
// bridge couldn't parse — either way, not a real chat message.
const HEARTBEAT_RE = /^\s*HEARTBEAT_OK\b/;
// A Python traceback in a reply body means Hermes itself crashed and the
// bridge's stderr-as-reply fallback picked up the crash dump. Reject
// rather than post it to the channel.
const TRACEBACK_RE = /^\s*Traceback \(most recent call last\):/m;
// XML-ish tool-call markup. Match opening AND closing variants of all three
// tag families — Hermes / OpenClaw sometimes emit only the closing `</invoke>`
// at the tail of a botched JSON tool call.
const TOOL_USE_RE = /<\/?tool_use\b|<\/?function_calls\b|<\/?invoke\b/i;
// JSON-shaped tool call, fenced or bare. Two fingerprints:
//   (a) legacy tool call: `{ "tool": "...", "input|arguments|parameters": ... }`
//   (b) <actions> entry emitted outside its block: `{ "type": "<action>", ... }`
//       where <action> is one of our known action types. Models sometimes
//       wrap a valid-looking action in a ```json``` fence as prose instead
//       of the literal <actions>[…]</actions> envelope.
const TOOL_CALL_JSON_RE =
  /\{[\s\S]{0,1200}["“]tool["”]\s*:\s*["“][^"”]+["”][\s\S]{0,1200}["“](?:input|arguments|parameters)["”]\s*:/i;
const ACTION_JSON_RE =
  /\{[\s\S]{0,400}["“]type["”]\s*:\s*["“](?:post_message|react|open_thread|request_approval|set_memory|call_tool|create_task|update_task|assign_task|task_comment|share_files)["”]/i;
const CURL_BLOCK_RE = /```[^`]*?\bcurl\s+-[^`]{0,500}```/s;
// Upstream LLM-gateway error strings that Hermes streams back as if they
// were model output. These are diagnostics, not a reply — reject.
//   "API call failed after 3 retries: HTTP 502: Provider error …"
//   "Provider error (<model>): <provider> API error NNN: …"
const GATEWAY_ERROR_RE =
  /(?:API call failed after \d+ retries|Provider error \([^)]+\):\s*[A-Za-z]+ API error \d{3})/i;
// Boilerplate assistant refusal phrases. Models sometimes slip into
// "helpful-assistant" mode and refuse instead of using their tools. None
// of these phrases appear in organic agent output; they're pure chat-ui
// hallucinations. Narrow patterns only — we don't want to reject a real
// reply that happens to start with "I'm sorry".
const ASSISTANT_REFUSAL_RE =
  /\bI (?:don't|do not) have access to the (?:necessary|required|tools|needed)\b|\bIf you have (?:any )?other questions,? or need help with something else\b|\bI(?:'m| am) (?:sorry,? but I|unable to|not able to)(?:[^.]{0,60})?(?:assist|help|access|capability|tools)\b/i;
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
  if (TRACEBACK_RE.test(trimmed)) return { ok: false, reason: "python_traceback" };
  if (TOOL_USE_RE.test(trimmed)) return { ok: false, reason: "tool_use_markup" };
  if (TOOL_CALL_JSON_RE.test(trimmed)) return { ok: false, reason: "tool_call_json" };
  if (ACTION_JSON_RE.test(trimmed)) return { ok: false, reason: "action_json_leaked" };
  if (GATEWAY_ERROR_RE.test(trimmed)) return { ok: false, reason: "gateway_error_echo" };
  if (ASSISTANT_REFUSAL_RE.test(trimmed)) return { ok: false, reason: "assistant_refusal" };
  if (HISTORY_ECHO_RE.test(trimmed)) return { ok: false, reason: "history_format_echo" };
  if (hasRunawayRepetition(trimmed)) return { ok: false, reason: "runaway_repetition" };
  if (CURL_BLOCK_RE.test(trimmed)) return { ok: false, reason: "curl_transcript" };
  if (PURE_JSON_FENCE_RE.test(trimmed) && trimmed.length > 400) {
    return { ok: false, reason: "pure_json_dump" };
  }
  return { ok: true, bodyMd: scrubbed };
}
