// Read-time scrub for text bodies served to the public.
//
// `sanitizeAgentProse` (agents/reply-guard.ts) cleans what an agent WRITES into
// a message or comment. It never sees a file: an agent writes markdown to
// /workspace and attaches it, and the bytes go to storage verbatim — which is
// correct, because the agent reads them back and the paths inside have to
// still resolve. But those same bytes are then served, unchanged, to anonymous
// visitors on live.circlechat.co, quoting `/opt/data/workspace/...` and
// `/workspace/auditor_manifest_sha256.json` at people who have no container to
// open them in.
//
// So this runs on the READ path only, and only for the public identity:
// storage keeps the original bytes, agents and signed-in members keep the
// original bytes, and the fishbowl visitor gets the filenames without the
// mount points.
//
// Deliberately light. It rewrites container paths and strips environment
// variable assignments, and touches nothing else — a deliverable is somebody's
// work, and an over-eager rewrite would corrupt it. Same vocabulary as
// web/src/lib/md.ts (`scrubIds`) so one document reads the same in the file
// viewer and in a chat quote.

import { sanitizeAgentProse } from "../agents/reply-guard.js";

// Absolute paths under the agent's mounts. The leading group is the delimiter
// (kept verbatim, including a backtick) so we don't need a lookbehind.
const CONTAINER_PATH_RE =
  /(^|[\s("'`[<])(\/(?:opt\/data|workspace|tmp)(?:\/[\w.@%+-]+)*)\/?/g;

// `HERMES_WRITE_SAFE_ROOT=/opt/data`, `VERIFY_FAIL_MODE=hold` — runtime knobs,
// never part of a deliverable's meaning.
const ENV_ASSIGN_RE = /\b[A-Z][A-Z0-9_]{3,}=(?:"[^"\n]*"|'[^'\n]*'|\S+)/g;

// Largest body we will rewrite. Above this we serve the original: the scrub
// has to buffer the whole file to do it, and a multi-megabyte deliverable is
// not what the paths-in-prose problem is about.
export const MAX_SCRUB_BYTES = 1024 * 1024;

// Pure. Returns the text with container paths reduced to their bare filename
// and env-var assignments removed.
export function scrubInternalPaths(text: string): string {
  let out = String(text ?? "");
  out = out.replace(CONTAINER_PATH_RE, (m: string, pre: string, p: string) => {
    // A trailing slash means it was a directory reference — there is no
    // filename worth showing, so the whole thing goes.
    if (m.endsWith("/")) return pre;
    const last = p.split("/").filter(Boolean).pop() ?? "";
    const keep = last && last !== "workspace" && last !== "tmp" && last !== "data" ? last : "";
    return `${pre}${keep}`;
  });
  out = out.replace(ENV_ASSIGN_RE, "");
  // Tidy what the removals leave behind, without touching line structure
  // (markdown and HTML both care about newlines).
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:!?])/g, "$1").replace(/\(\s*\)/g, "");
}

// ───────────────────── scrubPublicBody ─────────────────────
//
// `sanitizeAgentProse` cleans what an agent WRITES. It shipped in af6761a and
// it works — on new posts. Everything written before it existed is still in
// the database and still served verbatim, and the public board is mostly
// history: across the last 200 messages and 242 comments on live there were 27
// posts naming VERCEL_TOKEN, 22 quoting /workspace, 62 with a raw task_ id in
// prose, 39 carrying a sha256 digest, 300+ bare diff lines, a dozen comments
// with an inline JSON object literal (one of them a leaked memory tool call,
// `…"target":"memory"}}`), and three pasting the judge's own
// `VERIFICATION: pass | score: 1 | rationale: …` line as if it were prose.
//
// So the guard has to run on the READ path too, and only for the public
// identity: members and agents keep the exact bytes (a reviewer needs the
// rationale, an agent needs the path it just wrote to). This is the read-side
// twin of the write-side guard — same vocabulary, plus the classes that only
// matter once somebody else is reading:
//
//   env-var NAMES in prose (`VERCEL_TOKEN`)     → "a credential"
//   content digests (`sha256 18283e…`, 40-hex)  → dropped
//   `task_` / `ap_` / `goal_` ids               → what the thing is
//   inline JSON object literals and JSON tails  → dropped
//   unified-diff lines                          → dropped
//   `VERIFICATION: … rationale: …` lines        → dropped
//
// Pure string work, no I/O, nothing cached: it runs per row on a list read, so
// it stays linear in the body length and allocates nothing but strings.

// A SCREAMING_SNAKE identifier that names a secret. Requires the secret noun as
// the LAST segment, so runtime knobs (VERIFY_FAIL_MODE) and ordinary shouting
// ("TODO", "IMPORTANT") are untouched. `NAME=value` assignments are already
// removed by the prose pass; this is the bare name in a sentence.
const ENV_SECRET_NAME_RE =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PAT|DSN)\b/g;

// `sha256 18283e5ac601…`, `md5=d41d8cd9…`. The digest goes with the label that
// introduces it; a filename that merely contains the word (`manifest_sha256.json`)
// has no word boundary before `sha` and is left alone.
const DIGEST_MENTION_RE =
  /\(?\s*\b(?:sha-?(?:1|224|256|384|512)|md5|blake2b?)\b\s*[:=]?\s*[0-9a-f]{6,64}(?:…|\.{3})?\s*\)?/gi;
// A bare content digest / commit hash with no label in front of it.
const LONG_HEX_RE = /\b[0-9a-f]{32,64}\b/g;

// The judge's verdict line, pasted as prose. It is written for whoever tunes
// the rubric, and `spectatorTaskView` already strips the structured copy of the
// same text from the task payload.
const VERIFICATION_LINE_RE =
  /^[^\n]*\bVERIFICATION\b[^\n]*\brationale\b[ \t]*:[^\n]*$/gim;

// A JSON object literal sitting in a sentence — a tool call or a tool result
// the model narrated instead of acting on.
const JSON_OBJECT_RE = /\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
const JSON_KEY_RE = /"[\w.$-]+"\s*:/;
// The TAIL of one, where the opening brace was lost to truncation:
// `…approvals clear.","target":"memory"}}`.
const JSON_TAIL_VALUE = `(?:"[^"\\n]*"|-?\\d+(?:\\.\\d+)?|true|false|null|\\{[^{}\\n]*\\}|\\[[^\\[\\]\\n]*\\])`;
const JSON_TAIL_RE = new RegExp(
  `["']?\\s*,\\s*"[\\w.$-]+"\\s*:\\s*${JSON_TAIL_VALUE}` +
    `(?:\\s*,\\s*"[\\w.$-]+"\\s*:\\s*${JSON_TAIL_VALUE})*\\s*[}\\]]*\\s*$`,
  "gm",
);

// Unified-diff furniture. Always machinery, wherever it appears.
const DIFF_HEADER_RE =
  /^[ \t]*(?:diff --git |index [0-9a-f]{7,40}(?:\.\.|\s)|--- a\/|\+\+\+ b\/|@@ [-+]\d)/;
// A diff body line: the marker is followed immediately by content, so a
// markdown bullet ("- item", "+ item") never matches.
const STRONG_DIFF_LINE_RE = /^[+-](?![+-]|\s)\S/;
// `+ .controls { … }` — a diff line that happens to have a space after the
// marker. Ambiguous with a markdown bullet on its own, so it only counts when
// it sits in a run with a line that is unambiguously a diff.
const WEAK_DIFF_LINE_RE = /^[+-][ \t]+\S/;

// Drop unified-diff lines. Ambiguous "+ x" / "- x" lines go only when they are
// adjacent to a line that is certainly part of a diff, so a markdown list
// survives intact.
function stripDiffLines(text: string): string {
  const lines = text.split("\n");
  if (!lines.some((l) => DIFF_HEADER_RE.test(l) || STRONG_DIFF_LINE_RE.test(l))) return text;
  const certain = lines.map((l) => DIFF_HEADER_RE.test(l) || STRONG_DIFF_LINE_RE.test(l));
  const drop = certain.slice();
  for (let i = 0; i < lines.length; i++) {
    if (drop[i] || !WEAK_DIFF_LINE_RE.test(lines[i])) continue;
    if (certain[i - 1] || certain[i + 1] || drop[i - 1]) drop[i] = true;
  }
  return lines.filter((_l, i) => !drop[i]).join("\n");
}

// A fence whose contents were entirely machinery is now an empty pair of
// markers — remove it rather than render a blank code block.
const EMPTY_FENCE_RE = /```[a-z0-9+-]*[ \t]*\n[ \t\n]*```/gi;

function stripJsonLiterals(text: string): string {
  let out = text.replace(JSON_TAIL_RE, "");
  out = out.replace(JSON_OBJECT_RE, (m) => (JSON_KEY_RE.test(m) ? "" : m));
  return out;
}

/**
 * The body of a message or a task comment as the public identity may read it.
 * Pure; returns the original text for members/agents' callers to ignore — the
 * caller decides WHO gets this, `req.spectator` is the only switch.
 */
export function scrubPublicBody(text: string | null | undefined): string {
  const raw = String(text ?? "");
  if (!raw) return "";
  // Above the cap the scrub would buffer more than the problem is worth; the
  // body columns are capped at 20 000 chars, so this is a guard, not a path.
  if (Buffer.byteLength(raw, "utf8") > MAX_SCRUB_BYTES) return raw;

  // 1. Structural removals, line-shaped, before anything rewrites the prose.
  let out = raw.replace(VERIFICATION_LINE_RE, "");
  out = stripDiffLines(out);
  out = stripJsonLiterals(out);

  // 2. The write-side guard's own pass: container paths, dev ports, harness
  //    vocabulary, tool-call markup, runtime log lines, art_/m_ ids.
  out = sanitizeAgentProse(out).text;

  // 3. Tokens that only matter to a reader who is not on the team.
  out = out.replace(ENV_SECRET_NAME_RE, "a credential");
  out = out.replace(DIGEST_MENTION_RE, "");
  out = out.replace(LONG_HEX_RE, "");
  out = out.replace(/\btask_[a-z0-9]{12,28}\b/g, "this card");
  out = out.replace(/\bap_[a-z0-9]{12,28}\b/g, "an approval");
  out = out.replace(/\bgoal_[a-z0-9]{12,28}\b/g, "this goal");

  // 4. Close up what the removals left behind.
  return out
    .replace(EMPTY_FENCE_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Map over rows that carry a `bodyMd`, leaving every other field alone.
export function scrubPublicBodies<T extends { bodyMd?: string | null }>(rows: T[]): T[] {
  return rows.map((r) =>
    r && typeof r.bodyMd === "string" ? { ...r, bodyMd: scrubPublicBody(r.bodyMd) } : r,
  );
}

// The same scrub for a live event. Spectator sockets get the public copy of a
// body the moment it is broadcast — without this, a visitor with the tab open
// reads the raw text the REST endpoints refuse to serve them. Only the three
// event types that carry authored prose are rewritten; everything else is
// forwarded byte-for-byte.
export function scrubPublicEvent(raw: string): string {
  if (!raw.includes("bodyMd")) return raw;
  try {
    const ev = JSON.parse(raw) as {
      type?: string;
      bodyMd?: unknown;
      message?: { bodyMd?: unknown };
      comment?: { bodyMd?: unknown };
    };
    if (ev?.type === "message.new" && typeof ev.message?.bodyMd === "string") {
      ev.message.bodyMd = scrubPublicBody(ev.message.bodyMd);
    } else if (ev?.type === "message.edited" && typeof ev.bodyMd === "string") {
      ev.bodyMd = scrubPublicBody(ev.bodyMd);
    } else if (ev?.type === "task.comment.new" && typeof ev.comment?.bodyMd === "string") {
      ev.comment.bodyMd = scrubPublicBody(ev.comment.bodyMd);
    } else {
      return raw;
    }
    return JSON.stringify(ev);
  } catch {
    // Our own payloads are always valid JSON; an unparseable frame is not one
    // of the three shapes above, so there is nothing to rewrite.
    return raw;
  }
}
