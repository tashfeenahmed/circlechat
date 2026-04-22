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
const TOOL_USE_RE = /<\/?tool_use>|<function_calls>|<invoke name=/i;
const FN_CALL_BLOCK_RE = /```\s*(json|tool|function_call)?\s*\n\s*\{[^`]{0,2000}"(?:tool|name|arguments|parameters)"/i;
const CURL_BLOCK_RE = /```[^`]*?\bcurl\s+-[^`]{0,500}```/s;
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
  if (FN_CALL_BLOCK_RE.test(trimmed)) return { ok: false, reason: "function_call_json" };
  if (CURL_BLOCK_RE.test(trimmed)) return { ok: false, reason: "curl_transcript" };
  if (PURE_JSON_FENCE_RE.test(trimmed) && trimmed.length > 400) {
    return { ok: false, reason: "pure_json_dump" };
  }
  return { ok: true, bodyMd: scrubbed };
}
