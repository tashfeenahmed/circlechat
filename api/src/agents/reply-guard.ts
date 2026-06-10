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
// Bare function-call JSON: `{"name":"read_file","parameters":{…}}` /
// `{"name":"write_file","arguments":{…}}`. The runtime's internal tool-call
// shape leaking as the reply body (observed verbatim from Samantha:
// {"name": "read_file", "parameters": {"offset": 51, …}}). Distinct from the
// "tool"-keyed form above — this one keys on "name" + parameters/arguments.
const TOOL_NAME_JSON_RE =
  /\{\s*["“]name["”]\s*:\s*["“][a-z_][a-z0-9_]*["”]\s*,\s*["“](?:parameters|arguments|args|input)["”]\s*:/i;
// A code-runtime/interpreter banner dumped into the reply — the agent printed
// its sandbox env instead of replying. Observed: "Fiber: 0.7.0 (standalone) /
// Python: 3.13.5 / Pyodide: 0.x". None of these appear in organic chat.
const RUNTIME_BANNER_RE = /\b(?:Pyodide|Fiber)\s*:\s*\d|\bPython\s*:\s*3\.\d+\.\d+\b/i;
// A leaked structured-metadata fragment — usually a truncated tool/preamble
// envelope like "<metadata" or "<thinking" the model emitted as prose.
const META_TAG_FRAGMENT_RE = /^\s*<\/?(?:metadata|thinking|reasoning|scratchpad|plan)\b/i;
// Capability-failure boilerplate: the model gives up citing missing/unavailable
// tools instead of using its real action channel. Observed: "I can't help you
// without access to specific unavailable tools.", "the available tools do not
// seem to match". A real agent emits an <actions> block — it never narrates a
// tool deficit. Narrow to the deficit phrasings.
const CAPABILITY_FAILURE_RE =
  /\bI (?:can(?:'|’)?t|cannot|can not) help (?:you )?without access to\b|\b(?:the )?available tools (?:do|does) ?n(?:o|')t (?:seem to )?(?:match|include|have|support)\b|\bI (?:don'?t|do not) have (?:the )?(?:specific |necessary |required )?(?:unavailable |missing )?tools?\b/i;
const ACTION_JSON_RE =
  /\{[\s\S]{0,400}["“]type["”]\s*:\s*["“](?:post_message|react|open_thread|request_approval|set_memory|delete_memory|call_tool|create_task|update_task|assign_task|task_comment|share_files|share_to_task)["”]/i;
// Bare tool-call SYNTAX leaked as assistant text — a body that is (or starts
// with) a line like `session_search(query="x", limit=1)` or
// `update_task(task_id="…", status="done")`. The model is supposed to invoke
// these via the action side-channel / MCP, never type them as prose. The
// bridge strips these too, but guard server-side so an older bridge or the MCP
// post route can't let them through.
const TOOL_CALL_SYNTAX_RE =
  /^\s*(?:session_search|search|update_task|create_task|assign_task|task_comment|share_files|share_to_task|set_memory|delete_memory|open_thread|request_approval|post_message|react)\s*\((?:[^()]|\([^()]*\))*\)\s*$/im;
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
// "Meta-narration" leaks — models occasionally describe the act of posting
// instead of posting. Observed in practice: a Max message whose body was
// "Reply posted successfully to Nova in the analytics channel…" instead of
// the actual reply. These phrasings never appear in organic chat; they're
// the model narrating a tool-call it thought it was making. Keep narrow so
// real replies ("I posted the report to the shared drive") aren't caught.
const META_NARRATION_RE =
  /^\s*(?:Reply posted|(?:I(?:'ve| have)) (?:successfully |just |now )?posted (?:a |the |my )?(?:reply|response|message)|(?:Successfully |Just )?posted (?:a |the |my )?(?:reply|response|message) (?:to @|in #|in the)|Message (?:sent|posted) successfully|Sent (?:a |the |my )?(?:reply|response|message) to @|Action (?:completed|executed) successfully)/i;

// Asking a human to hand over a secret in a logged surface. The CREDENTIALS
// rule is absolute: the ONLY channel for a secret is request_approval (the
// human attaches it to the approval and it lands as an env var). Begging for a
// token/password/credential in chat or a task comment is both a security
// problem and the engine of the credential-begging loop. Narrow to an explicit
// imperative ask for a SECRET so genuine prose ("the API returned a token") and
// blocker-naming ("blocked: filed an approval for the deploy token") don't trip
// it — it needs a request verb AND a secret noun.
const CREDENTIAL_BEG_RE =
  /\b(?:provide|paste|share|send|give|hand\s+over|need\s+you\s+to\s+(?:provide|share|send)|can\s+you\s+(?:provide|share|paste|send)|please\s+(?:provide|share|paste|send))\b[^.\n]{0,60}\b(?:password|api[\s-]?key|api[\s-]?token|access[\s-]?token|auth[\s-]?token|secret|credentials?|github\s+pat|personal\s+access\s+token|netlify\s+(?:token|key)|vercel\s+token)\b/i;

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
// Phrases that explicitly claim a file is attached to this very message. If
// the body matches one of these but no actual attachment is bundled with the
// action, the agent has hallucinated the deliverable — reject so its next
// turn either ships the file via share_to_task / share_files or rewrites
// the prose to drop the claim. Narrow patterns only: "the file shows" or
// "I compiled a list" must NOT trigger; only literal attachment promises do.
const ATTACHMENT_CLAIM_RE =
  /\b(?:see\s+(?:the\s+)?attached|attached\s+(?:please\s+find|is\s+(?:the|a|my)|herewith|file|files|document|doc|list|report|pdf|spreadsheet|csv|json|markdown)|please\s+find\s+attached|find\s+attached|I(?:'ve|\s+have)\s+attached|attaching\s+(?:the|a|my)|file\s+attached|📎\s*attached)\b/i;

// Fabricated-deployment claim: prose asserting a COMPLETED deploy/upload/
// publish to an external hosting service with no verifiable URL anywhere in
// the body. Observed in practice: phil claimed "I have deployed the
// neu_ie.html file to Netlify Drop" four times across two days without ever
// producing a URL (Netlify Drop is a browser drag-and-drop — the agent can't
// even do it headlessly). Past/perfect tense only, so plans and questions
// ("I can deploy to Netlify", "should we use Vercel?") don't trip it. A real
// completed deploy always has a URL to show — require one.
const DEPLOY_CLAIM_RE =
  /\b(?:(?:I|we)(?:['’]ve| have| just)?\s+(?:successfully\s+|now\s+)?|has\s+(?:been\s+)?(?:successfully\s+)?|have\s+been\s+|was\s+(?:successfully\s+)?|successfully\s+)(?:re-?)?(?:deployed|uploaded|published)\b(?:[^.\n]|\.(?=\w)){0,100}\b(?:to|on|via|at|using)\s+(?:Netlify|Vercel|GitHub\s+Pages|Cloudflare\s+Pages|Render|Surge|Fly\.io|Heroku|Railway)\b|\bStatus:\s*Deployed\b|\b(?:the\s+)?deployment\s+is\s+(?:now\s+)?complete\b/i;
const HAS_URL_RE = /https?:\/\/\S+/i;

// A visible <actions> tag in a final body is always a leak: the bridge
// strips every WELL-FORMED block before the post reaches us, so anything
// that still carries the tag is a malformed/truncated block (e.g.
// "<actions>\n[\n</actions>" when the model hit its token cap mid-JSON).
// Ten of these were visible in #neu-site over one 48h window.
const VISIBLE_ACTIONS_RE = /<\/?actions>/i;

// Leaked chain-of-thought: the model narrating its plan / the prompt it was
// given instead of replying. Observed verbatim in #neu-site: "The user wants
// me to respond to the conversation…", "I am acting as Rachel (@rachel), the
// Researcher.", "Looking at the conversation history:", "Recent Messages
// Analysis:". A real chat reply never opens by describing what "the user"
// asked or announcing which persona it's playing. Anchored to the start and
// narrow so genuine replies aren't caught.
const COT_LEAK_RE =
  /^\s*(?:The user (?:wants|is asking|is providing|has provided|just|now)\b|I (?:am|'m) (?:acting as|currently|now acting)\b|I am [A-Z][a-z]+ \(@[a-z0-9_]+\)|Looking at the (?:conversation|recent|message|context|thread)|Recent [Mm]essages?\s+[Aa]nalysis|(?:The|Recent) (?:messages?|conversation|context)(?: in (?:the|this) channel)? (?:show|shows|indicate)\b|Current (?:Goal|Task|Context)\s*[:`])/;
// Raw API-call script leaked as a reply — the agent printed the Python it wrote
// to hit /agent-api instead of replying. CC_API_BASE / CC_BOT_TOKEN / urllib
// never appear in an organic chat message.
const API_SCRIPT_RE =
  /\bos\.environ(?:\.get)?\s*[([]\s*["']CC_(?:API_BASE|BOT_TOKEN)["']|\burllib\.request\b|^\s*import\s+urllib\b/im;
// Code/diff dump: 3+ `+`-prefixed source OR markdown lines (a pasted diff).
// The code patterns catch script diffs (import/def/assignment/call); the
// markdown patterns catch the mutated form seen after the script leaks were
// fixed — agents pasting diffs of their .md status reports ("+# Deployment
// Status Report", "+**Issue**: …"). Both stay anchored to a leading `+` so
// markdown bullets ("- foo") and "+1" acks don't trip it.
function looksLikeCodeDiffDump(s: string): boolean {
  // Both diff polarities: agents paste removed-line (`-`) hunks too, which the
  // older `+`-only detector missed (observed: Phil dumping "-// Demo Widget…",
  // "-document.addEventListener(…" lines). `[+-]` covers add AND remove.
  const codeDiff = (
    s.match(
      /^\s*[+-]\s*(?:import |from |def |class |with |try:|except|return |print\(|const |let |var |function |document\.|window\.|\/\/|\/\*|<!--|req\b|resp\b|headers\b|url\b|token\b|api_base\b|<\/?[a-z]|[A-Za-z_][\w.]*\s*=\s*\S)/gim,
    ) || []
  ).length;
  const mdDiff = (s.match(/^[+-]\s*(?:#{1,6}\s|\*\*\S|[-*]\s+\S|>\s)/gm) || [])
    .length;
  return codeDiff >= 3 || mdDiff >= 3;
}

function scrubSecrets(s: string): string {
  return s
    .replace(BEARER_LEAK_RE, "Authorization: Bearer ***")
    .replace(RAW_BOT_TOKEN_RE, "cc_***");
}

// Actionable guidance appended to the rejection error fed back to the agent
// on its next turn. Only reasons where the fix isn't obvious from the name.
export function guardRejectHint(reason: string): string {
  switch (reason) {
    case "attachment_claim_no_file":
      return " Your prose claims a file is attached but no attachment was sent. Either include the file via share_files in this turn, or rewrite to remove the attachment claim.";
    case "deploy_claim_no_url":
      return " Your prose claims a completed deployment but includes no URL proving it. If the deploy really happened, repost with the live URL. If it didn't (e.g. you lack credentials or the service needs a browser), say you are BLOCKED and what you need — do NOT claim success.";
    case "actions_block_visible":
      return " Your reply still contains a literal <actions> tag — the block was malformed (likely truncated JSON) so it could not be parsed and stripped. Re-emit the complete, valid <actions>[…]</actions> block.";
    case "api_script_leak":
      return " You pasted/ran a raw API script (urllib, CC_API_BASE, CC_BOT_TOKEN) — you never need that. To act on the board, emit an <actions> JSON block, e.g. {\"type\":\"task_comment\",\"task_id\":\"task_…\",\"body_md\":\"…\"} or {\"type\":\"update_task\",\"task_id\":\"task_…\",\"status\":\"review\"}. To ship code or a document, write it to a file under /workspace and attach it with share_to_task — do not paste the script into chat.";
    case "code_diff_leak":
      return " You pasted code or a diff into the body. Write the code to a file under /workspace, attach it with share_to_task, and describe the change in plain prose. A short inline snippet in a ```fence``` is fine; a multi-line diff dump is not.";
    case "tool_call_syntax":
      return " You typed a tool call as prose (e.g. update_task(...)). Emit it as an <actions> JSON block instead, e.g. {\"type\":\"update_task\",\"task_id\":\"task_…\",\"status\":\"…\"}.";
    case "tool_call_json":
    case "action_json_leaked":
      return " An action's JSON ended up in your visible reply. Wrap actions in an <actions>[ … ]</actions> block — they are executed from there and stripped from the message, never posted as text.";
    case "cot_leak":
      return " Your reply leaked planning/persona narration (\"The user wants…\", \"I am acting as…\"). Reply directly in your own voice — don't describe the conversation or announce your role.";
    case "credential_beg":
      return " You asked a human to hand over a secret in chat — never do that. The ONLY way to receive a credential is a request_approval action: describe what you need; if the human approves they attach the secret and it arrives as an env var. If a similar request was already denied, that's final — mark the dependent task \"blocked\" or take an approach that needs no credential.";
    case "capability_failure":
      return " Don't narrate missing tools. You act on the board by emitting an <actions> JSON block (task_comment, update_task, share_to_task, …) and read context with curl against $CC_API_BASE — those always work. Do the next concrete step instead of declaring you can't.";
    case "runtime_banner_leak":
      return " Your reply leaked a code-runtime/interpreter banner (Pyodide/Fiber/Python version). That's sandbox noise, not a reply — write your answer in plain prose, and emit any board action in an <actions> block.";
    case "meta_tag_fragment":
      return " Your reply started with a leaked envelope tag (<metadata>/<thinking>/…). Reply with plain prose only; put any action in an <actions>[…]</actions> block.";
    case "pure_json_dump":
      return " Your whole message is a JSON blob. If it's an action, put it in an <actions> block; if it's data to share, write it to a /workspace file and attach it via share_to_task with a one-line caption.";
    case "curl_transcript":
      return " You pasted a curl command. You don't need raw HTTP — use an <actions> block to act on the board, or share_to_task to attach a file you wrote to /workspace.";
    default:
      return "";
  }
}

export function checkReplyBody(
  bodyMd: string,
  opts?: { hasAttachments?: boolean },
): GuardResult {
  const scrubbed = scrubSecrets(bodyMd);
  const trimmed = scrubbed.trim();
  if (!trimmed) return { ok: false, reason: "empty_body" };
  if (HEARTBEAT_RE.test(trimmed)) return { ok: false, reason: "heartbeat_leaked" };
  if (TRACEBACK_RE.test(trimmed)) return { ok: false, reason: "python_traceback" };
  if (TOOL_USE_RE.test(trimmed)) return { ok: false, reason: "tool_use_markup" };
  if (TOOL_CALL_JSON_RE.test(trimmed)) return { ok: false, reason: "tool_call_json" };
  if (TOOL_NAME_JSON_RE.test(trimmed)) return { ok: false, reason: "tool_call_json" };
  if (ACTION_JSON_RE.test(trimmed)) return { ok: false, reason: "action_json_leaked" };
  if (TOOL_CALL_SYNTAX_RE.test(trimmed)) return { ok: false, reason: "tool_call_syntax" };
  if (RUNTIME_BANNER_RE.test(trimmed)) return { ok: false, reason: "runtime_banner_leak" };
  if (META_TAG_FRAGMENT_RE.test(trimmed)) return { ok: false, reason: "meta_tag_fragment" };
  if (GATEWAY_ERROR_RE.test(trimmed)) return { ok: false, reason: "gateway_error_echo" };
  if (ASSISTANT_REFUSAL_RE.test(trimmed)) return { ok: false, reason: "assistant_refusal" };
  if (CAPABILITY_FAILURE_RE.test(trimmed)) return { ok: false, reason: "capability_failure" };
  if (CREDENTIAL_BEG_RE.test(trimmed)) return { ok: false, reason: "credential_beg" };
  if (HISTORY_ECHO_RE.test(trimmed)) return { ok: false, reason: "history_format_echo" };
  if (META_NARRATION_RE.test(trimmed)) return { ok: false, reason: "meta_narration" };
  if (VISIBLE_ACTIONS_RE.test(trimmed)) return { ok: false, reason: "actions_block_visible" };
  if (DEPLOY_CLAIM_RE.test(trimmed) && !HAS_URL_RE.test(trimmed)) {
    return { ok: false, reason: "deploy_claim_no_url" };
  }
  if (COT_LEAK_RE.test(trimmed)) return { ok: false, reason: "cot_leak" };
  if (API_SCRIPT_RE.test(trimmed)) return { ok: false, reason: "api_script_leak" };
  if (looksLikeCodeDiffDump(trimmed)) return { ok: false, reason: "code_diff_leak" };
  if (hasRunawayRepetition(trimmed)) return { ok: false, reason: "runaway_repetition" };
  if (CURL_BLOCK_RE.test(trimmed)) return { ok: false, reason: "curl_transcript" };
  if (PURE_JSON_FENCE_RE.test(trimmed) && trimmed.length > 400) {
    return { ok: false, reason: "pure_json_dump" };
  }
  if (opts && opts.hasAttachments === false && ATTACHMENT_CLAIM_RE.test(trimmed)) {
    return { ok: false, reason: "attachment_claim_no_file" };
  }
  return { ok: true, bodyMd: scrubbed };
}
