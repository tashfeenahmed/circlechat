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

import { redactSecrets } from "../lib/redaction.js";

export type GuardResult =
  | { ok: true; bodyMd: string }
  | { ok: false; reason: string };

// HEARTBEAT_OK is the internal "silence" sentinel — it must NEVER reach a
// channel. Match it ANYWHERE, not just at the start: observed leaks put it after
// a runtime warning ("Warning: Unknown toolsets: … /// HEARTBEAT_OK"), bolded
// mid-reply ("**HEARTBEAT_OK** — I've scoped…"), and trailing a chain-of-thought
// dump. Bare HEARTBEAT (no _OK) is matched too: models echo the trigger word
// itself as their whole reply (observed twice in #neu-site). Uppercase-only and
// word-bounded, so prose about "the heartbeat monitor" stays unaffected —
// the all-caps token never legitimately appears in organic chat.
const HEARTBEAT_RE = /\bHEARTBEAT(?:_OK)?\b/;
// Upstream "the model produced nothing" notices that the hermes runtime streams
// to stdout (not from our code) and the bridge can pick up as a reply, e.g.
// "⚠️ No reply: the model returned empty content after retries and any fallback
// providers. Try `continue`, switch model/provider…". It's operator diagnostics,
// never a message — reject so it can't post into a user channel.
const EMPTY_REPLY_NOTICE_RE =
  /\bNo reply:\s*the model returned empty content\b|returned empty content after retries|\bswitch model\/provider\b/i;
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
// LLM-gateway / provider error strings surfacing on the REPLY path — the
// GATEWAY_ERROR_RE above only matches the "API call failed after N retries" /
// "Provider error (…)" shapes. A different shape leaked verbatim as an agent
// reply (len=109):
//   "HTTP 400: All routed providers rejected the request as invalid.
//    Last error: Cohere API error 400: Bad Request"
// Conservative: an HTTP-status line or a "<Provider> API error NNN" fragment at
// the very START of the reply (the reply IS the error), or the gateway's
// "All routed providers" phrase which never appears in organic chat. A reply
// that merely DISCUSSES an error mid-sentence ("I hit an HTTP 500 on deploy,
// retrying") isn't anchored to the start and passes.
const PROVIDER_ERROR_ECHO_RE =
  /^\s*(?:HTTP\s+\d{3}\s*:|[A-Za-z][\w./-]* API error \d{3}\b)|\bAll routed providers\b/i;
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
  /^\s*(?:The user (?:wants|is asking|is providing|has provided|just|now)\b|We (?:need|have|should|must) to (?:answer|respond|reply|address|handle|figure)\b|The latest (?:user )?message\b|(?:after|since) (?:the )?(?:big )?context compaction\b|\[CONTEXT COMPACTION|I (?:am|'m) (?:acting as|currently|now acting)\b|I am [A-Z][a-z]+ \(@[a-z0-9_]+\)|Looking at (?:the|my) (?:conversation|recent|message|context|thread|tasks?|board|the board)|Recent [Mm]essages?\s+[Aa]nalysis|(?:The|Recent) (?:messages?|conversation|context)(?: in (?:the|this) channel)? (?:show|shows|indicate)\b|Current (?:Goal|Task|Context)\s*[:`])/;
// Third-person narration of a tool call / browser transcript posted AS the
// reply. The live #general filled with these — the model described what a
// browser/DOM tool returned ("The title of the webpage is …", "The browser
// snapshot shows …", "The browser console output is empty …", "The page has a
// heading …"), narrated its own plan in the third person ("The user's goal is
// to extract …", "Based on the user's response, I will proceed …"), or named a
// browser_* tool function instead of answering. A genuine work update speaks in
// the first person about the work ("I've created the file and attached it",
// "Sharing the showcase brief for review") and never opens by describing a
// page/browser/tool result — so anchor every phrase to the START and keep the
// nouns specific (a bare "The browser compatibility looks fine" must still
// pass). browser_* function names are matched anywhere (they never appear in
// organic chat).
const TOOL_NARRATION_RE =
  /^\s*(?:The user'?s goal is\b|The browser(?:_\w+|\s+(?:snapshot|console|tab|page|window|dom|viewport|history|output|url|title|content))\b|The page has a heading\b|The title of the (?:web ?page|page) is\b|The (?:\w+ )?snapshot shows\b|Based on the user'?s (?:response|answer|reply|message)\b)|\bbrowser_(?:navigate|snapshot|click|type|screenshot|console|tab|select|wait|evaluate|extract|get_text|hover|press|scroll|fill)\b/i;
// Degenerate "language soup": small models occasionally collapse into output
// that sprinkles characters from several non-Latin scripts through otherwise
// Latin text (observed: "…exactery387392ジ Comm Blvd街道1791 Zahy సి 8 …农业农村部
// report"). A genuine non-English message is mostly ONE script; degeneration is
// majority-Latin with isolated exotic chars from MULTIPLE scripts. Reject only
// when there are several exotic chars AND Latin still dominates — so a real
// Chinese/Japanese/etc. message (majority-exotic) is never caught.
function looksLikeGarbledOutput(s: string): boolean {
  const exotic = (s.match(
    /[一-鿿぀-ゟ゠-ヿ가-힯ఀ-౿฀-๿ऀ-ॿ؀-ۿЀ-ӿ]/g,
  ) || []).length;
  if (exotic < 6) return false;
  const latin = (s.match(/[a-zA-Z]/g) || []).length;
  return latin >= exotic * 2;
}
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
  if (codeDiff >= 3 || mdDiff >= 3) return true;
  // Plain-prose diff: a pasted hunk whose lines are neither code nor markdown
  // shaped ("+Neu Site Verification", "+Timestamp: $(date -u)", bare "+" spacer
  // lines — observed from Phil in #general). Count lines that start with the
  // polarity sign glued to content (or standing alone); require them to be
  // both numerous AND the bulk of the message so "+1" acks, phone numbers, and
  // "---" separators sprinkled through normal prose never trip it.
  const lines = s.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const plainDiff = nonEmpty.filter((l) => /^[+-](?:\S|\s*$)/.test(l)).length;
  return plainDiff >= 4 && plainDiff >= Math.ceil(nonEmpty.length * 0.6);
}

function scrubSecrets(s: string): string {
  // Shared redaction (provider token shapes, key=value assignments, PEM, JWT)
  // plus the two chat-specific shapes that predate it.
  return redactSecrets(s)
    .replace(BEARER_LEAK_RE, "Authorization: Bearer ***")
    .replace(RAW_BOT_TOKEN_RE, "cc_***");
}

// ─────────── Hermes runtime scaffolding that leaks as a reply PREFIX ───────────
// When the agent loop hits its `max_turns` cap, Hermes prints
//   "⚠️  Reached maximum iterations (20). Requesting summary..."
// and then asks the model for a wrap-up, which typically opens "Here's what I
// found and did this turn:". Live fishbowl: 400 chat messages + 176 task
// comments in one week BEGAN with that banner. The summary underneath is
// often real work, so STRIP the banner (and the lead-in line) and keep the
// remainder; reject only when nothing substantive is left.
const RUNAWAY_BANNER_RE =
  /(?:^|\n)[ \t]*⚠?\uFE0F?[ \t]*Reached maximum iterations(?:\s*\(\d+\))?\.?(?:[ \t]*Requesting (?:a )?summary(?:\.{1,3}|…)?)?[ \t]*(?:\n|$)/gi;
const SUMMARY_LEADIN_RE =
  /(?:^|\n)[ \t]*(?:\*\*)?(?:Here(?:'|’)s|Here is) (?:what|a (?:quick |brief )?summary of what) I(?:'ve| have)? (?:found|did|done|found and did|did and found)(?: (?:so far|this turn|in this turn))?[.:]?(?:\*\*)?[ \t]*(?:\n|$)/gi;
// Hermes' tool-dispatcher failure notice, e.g.
//   ⚠ Could not execute tool(s): "target": value "files\n@@ARG_END" not in enum […]
// It's a paragraph (runs to the next blank line, may contain the quoted
// argument text with embedded newlines). Strip the whole paragraph.
const TOOL_EXEC_FAIL_RE =
  /(?:^|\n)[ \t]*⚠?\uFE0F?[ \t]*Could not execute tool\(s\)[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*/gi;
// Argument-delimiter debris from Hermes' text-based tool-call parser
// (`@@ARG_START` / `@@ARG_END` and friends). If any survives the paragraph
// strip above, the body is machinery — reject.
const ARG_DEBRIS_RE = /@@(?:ARGS?|TOOL|CALL|FUNC|PARAMS?)[A-Z0-9_]*(?:_(?:START|END|BEGIN))?\b|@@ARG_END|@@ARG_START/;
// The model talking to the PROMPT SCAFFOLDING instead of the humans: "I've read
// the attached conversation history file in full. However, I don't see a
// section titled "CURRENT REQUEST (full text)"…". Those section names exist
// only in the packet we build; a real reply never mentions them.
const SCAFFOLD_TALK_RE =
  /CURRENT REQUEST \(full text\)|section titled ["“]CURRENT REQUEST|\battached conversation[- ]history file\b|\bconversation history file\b|\bI(?:'ve| have) read the (?:attached|provided) (?:conversation|context|history|file)\b/i;

// Ritual sign-offs: "*Signed,* **@iris** — Researcher & Writer, Circle Labs —
// *Artifact SHA-256 (compute…". Nobody signs a chat message. Cut from a
// closer line ("Signed,", "Regards,", "Best regards," …) to the end, drop a
// trailing "— @handle — Title" signature line, and drop any "Artifact
// SHA-256" footer line wherever it sits.
const SIGNOFF_CLOSER_RE =
  /(?:^|\n)[ \t]*[*_]{0,3}(?:[Ss]igned|[Rr]egards|[Kk]ind regards|[Bb]est regards|[Ww]arm regards|[Ss]incerely|[Cc]heers|[Rr]espectfully|[Yy]ours (?:truly|sincerely|faithfully))[,.]?[*_]{0,3}(?:[ \t]*(?=\n|$)|[ \t]+(?=[*_—–-]*[ \t]*@)|[ \t]+[A-Z][\w.'-]*(?:[ \t]+[A-Z][\w.'-]*){0,3}[*_]{0,3}[ \t]*(?=\n|$))/;
const SIGNATURE_LINE_RE =
  /\n[ \t]*(?:[—–-]+[ \t]*[*_]{0,3}@[a-z0-9][a-z0-9._-]*[*_]{0,3}[^\n]*|[*_]{1,3}@[a-z0-9][a-z0-9._-]*[*_]{1,3}[ \t]*[—–][^\n]*)[ \t]*$/i;
const SHA_FOOTER_RE = /(?:^|\n)[^\n]*\bArtifact SHA-?256\b[^\n]*/gi;

export function stripSignOff(s: string): string {
  let out = s;
  const closer = SIGNOFF_CLOSER_RE.exec(out);
  if (closer) out = out.slice(0, closer.index);
  out = out.replace(SHA_FOOTER_RE, "\n");
  // Signature line only when there is content above it — a whole reply that is
  // "@bob — ping" must survive.
  const sig = SIGNATURE_LINE_RE.exec(out);
  if (sig && out.slice(0, sig.index).trim()) out = out.slice(0, sig.index);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export interface ScaffoldStrip {
  text: string;
  // Leak classes removed, in the order found. Empty when nothing was stripped.
  stripped: string[];
}

// Remove leaked runtime scaffolding + sign-offs, keeping the substantive
// remainder. Exported for tests and for the bridge-side mirror.
// Hermes gateway boot banner leaking through the reply stream:
//   ┌──…┐ / │ ⚕ Hermes Gateway Starting... │ / │ Messaging platforms + cron
//   scheduler │ / │ Press Ctrl+C to stop │ / └──…┘  (box-drawing frame, any
// width, sometimes flattened onto one line). Pure runtime output — strip it.
const GATEWAY_BOOT_LINE_RE =
  /(?:^|\n)[ \t]*[┌┐└┘├┤─│╭╮╰╯═║╔╗╚╝]*[ \t]*(?:⚕[ \t]*)?(?:Hermes Gateway Starting\.{0,3}|Messaging platforms \+ cron scheduler|Press Ctrl\+C to stop)[^\n]*(?=\n|$)/gi;
const BOX_ONLY_LINE_RE = /(?:^|\n)[ \t]*[┌┐└┘├┤─│╭╮╰╯═║╔╗╚╝][┌┐└┘├┤─│╭╮╰╯═║╔╗╚╝ \t]*(?=\n|$)/g;
// Flattened single-line variant: "┌┐ ⚕ Hermes Gateway Starting... ├┤ Messaging
// platforms + cron scheduler Press Ctrl+C to stop └┘".
const GATEWAY_BOOT_INLINE_RE =
  /[┌┐└┘├┤─│╭╮╰╯═║╔╗╚╝ \t]*(?:⚕[ \t]*)?Hermes Gateway Starting\.{0,3}[ \t┌┐└┘├┤─│╭╮╰╯═║╔╗╚╝]*(?:Messaging platforms \+ cron scheduler)?[ \t┌┐└┘├┤─│╭╮╰╯═║╔╗╚╝]*(?:Press Ctrl\+C to stop)?[ \t┌┐└┘├┤─│╭╮╰╯═║╔╗╚╝]*/gi;

// Hermes "file-mutation verifier" notice: a header line followed by one bullet
// per denied write, e.g.
//   ⚠️ File-mutation verifier: 1 file(s) were NOT modified this turn despite …
//     • `/workspace/tmp/x.py` — [write_file] Write denied: '…' is outside HERMES_WRITE_SAFE_ROOT (/opt/data). Unset …
// Runtime diagnostics, never something a teammate should read.
export function stripFileMutationNotice(s: string): { text: string; hit: boolean } {
  const lines = s.split("\n");
  const out: string[] = [];
  let hit = false;
  let skipping = false;
  for (const line of lines) {
    if (/File-mutation verifier:/i.test(line)) {
      hit = true;
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s*[•\-*]\s/.test(line) || /Write denied|WRITE_SAFE_ROOT|Unset the variable|directory prefix/i.test(line)) continue;
      skipping = false;
      if (!line.trim()) continue;
    }
    out.push(line);
  }
  return { text: hit ? out.join("\n") : s, hit };
}

export function stripLeakedScaffolding(s: string): ScaffoldStrip {
  const stripped: string[] = [];
  let out = s;
  const step = (re: RegExp, reason: string, repl = "\n") => {
    if (re.test(out)) {
      stripped.push(reason);
      re.lastIndex = 0;
      out = out.replace(re, repl);
    }
    re.lastIndex = 0;
  };
  step(RUNAWAY_BANNER_RE, "runaway_banner");
  step(TOOL_EXEC_FAIL_RE, "tool_exec_failure");
  {
    const fm = stripFileMutationNotice(out);
    if (fm.hit) {
      stripped.push("file_mutation_notice");
      out = fm.text;
    }
  }
  if (/Hermes Gateway Starting|Messaging platforms \+ cron scheduler|Press Ctrl\+C to stop/i.test(out)) {
    stripped.push("gateway_boot");
    out = out.replace(GATEWAY_BOOT_LINE_RE, "\n").replace(GATEWAY_BOOT_INLINE_RE, " ").replace(BOX_ONLY_LINE_RE, "\n");
  }
  if (stripped.includes("runaway_banner")) step(SUMMARY_LEADIN_RE, "summary_leadin");
  const unsigned = stripSignOff(out);
  if (unsigned !== out.trim()) {
    stripped.push("signoff");
    out = unsigned;
  }
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), stripped };
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
      return " Your reply leaked planning/persona narration (\"The user wants…\", \"We need to answer…\", \"Looking at my tasks…\"). Reply directly in your own voice — don't describe the conversation, the compaction, or announce your role.";
    case "tool_narration":
      return " You narrated a tool/browser result or your own plan instead of replying (\"The browser snapshot shows…\", \"The title of the webpage is…\", \"The user's goal is…\"). Say what YOU did or found in your own first-person voice (\"I checked the page — the title is X\") and put any board action in an <actions> block. Don't paste tool transcripts.";
    case "provider_error_echo":
      return " A gateway/provider error string leaked into your reply (\"HTTP 400…\", \"All routed providers…\", \"… API error 400\"). That's runtime diagnostics, not a message — never post it. Retry the work; if you're genuinely blocked, say so in plain prose or stay silent with exactly HEARTBEAT_OK.";
    case "garbled_output":
      return " Your reply was garbled (random characters from multiple scripts). That's a model glitch, not a message. Re-read the last message and reply in plain English, or emit only an <actions> block / HEARTBEAT_OK.";
    case "empty_reply_notice":
      return " A runtime 'no reply / empty content' notice leaked into your body. Don't post diagnostics. Either take a concrete board action in an <actions> block or stay silent with exactly HEARTBEAT_OK.";
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
    case "runaway_banner":
      return " Your reply was only the runtime's 'Reached maximum iterations' banner — you ran out of tool turns before saying anything. Do fewer tool calls per turn: pick ONE concrete step, do it, and report it in a sentence or two (or an <actions> block). Never paste runtime warnings.";
    case "tool_exec_failure":
    case "tool_parse_debris":
      return " Your reply carried the runtime's 'Could not execute tool(s)' notice / @@ARG parser debris — a tool call you emitted was malformed. That's diagnostics, not a message. Re-issue the tool call correctly (valid enum values, no stray delimiters) or emit the board action as an <actions> JSON block; only post prose that a teammate should read.";
    case "scaffold_talk":
      return " You addressed the prompt scaffolding ('CURRENT REQUEST', 'attached conversation history file') instead of the team. Nobody attached a file — the context you were given IS the conversation. Reply to the last human message in plain prose, or stay silent with HEARTBEAT_OK.";
    case "file_mutation_notice":
      return " Your reply was only the runtime's 'File-mutation verifier' notice — a write was denied. That is diagnostics for you, not a message. Fix the path (write under /opt/data) and post only the outcome a teammate needs.";
    case "gateway_boot":
      return " Your reply was only the Hermes gateway's boot banner ('Hermes Gateway Starting…') — runtime output, not a message. Say the one new fact for the team, or stay silent with HEARTBEAT_OK.";
    case "signoff_only":
      return " Your reply was only a signature/sign-off. Chat messages carry no sign-offs, no name/title lines, no hash footers — say the one new fact, then stop.";
    default:
      return "";
  }
}

export function checkReplyBody(
  bodyMd: string,
  opts?: { hasAttachments?: boolean },
): GuardResult {
  // Strip leaked runtime scaffolding (runaway-iterations banner, tool-dispatch
  // failure paragraphs, sign-offs) FIRST so a reply with a substantive body
  // under the noise still posts — clean. If nothing substantive survives, the
  // first stripped class is the reason (it teaches better than "empty_body").
  const { text: scrubbed, stripped } = stripLeakedScaffolding(scrubSecrets(bodyMd));
  const trimmed = scrubbed.trim();
  if (!trimmed) {
    const lead = stripped.find((r) => r !== "summary_leadin");
    return { ok: false, reason: lead === "signoff" ? "signoff_only" : lead || "empty_body" };
  }
  if (ARG_DEBRIS_RE.test(trimmed)) return { ok: false, reason: "tool_parse_debris" };
  if (SCAFFOLD_TALK_RE.test(trimmed)) return { ok: false, reason: "scaffold_talk" };
  if (HEARTBEAT_RE.test(trimmed)) return { ok: false, reason: "heartbeat_leaked" };
  if (EMPTY_REPLY_NOTICE_RE.test(trimmed)) return { ok: false, reason: "empty_reply_notice" };
  if (TRACEBACK_RE.test(trimmed)) return { ok: false, reason: "python_traceback" };
  if (TOOL_USE_RE.test(trimmed)) return { ok: false, reason: "tool_use_markup" };
  if (TOOL_CALL_JSON_RE.test(trimmed)) return { ok: false, reason: "tool_call_json" };
  if (TOOL_NAME_JSON_RE.test(trimmed)) return { ok: false, reason: "tool_call_json" };
  if (ACTION_JSON_RE.test(trimmed)) return { ok: false, reason: "action_json_leaked" };
  if (TOOL_CALL_SYNTAX_RE.test(trimmed)) return { ok: false, reason: "tool_call_syntax" };
  if (RUNTIME_BANNER_RE.test(trimmed)) return { ok: false, reason: "runtime_banner_leak" };
  if (META_TAG_FRAGMENT_RE.test(trimmed)) return { ok: false, reason: "meta_tag_fragment" };
  if (GATEWAY_ERROR_RE.test(trimmed)) return { ok: false, reason: "gateway_error_echo" };
  if (PROVIDER_ERROR_ECHO_RE.test(trimmed)) return { ok: false, reason: "provider_error_echo" };
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
  if (TOOL_NARRATION_RE.test(trimmed)) return { ok: false, reason: "tool_narration" };
  if (looksLikeGarbledOutput(trimmed)) return { ok: false, reason: "garbled_output" };
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
