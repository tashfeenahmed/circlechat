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

// ────────────── titles, names and the rest of the public surface ──────────────
//
// #64 wired `scrubPublicBody` to the three surfaces that obviously carry an
// agent's prose: chat messages, task comments and search hits. But an agent
// writes the same prose into a card TITLE, a goal BODY and a "Needs you"
// DETAIL line, and those responses still went out verbatim. On live today,
// with no session at all:
//
//   GET /api/tasks   → "**Implementation**: backend/server.js (28575B, 706
//                       lines) at /workspace/backend/server.js"
//                    → "root cause was a stale server snapshot from
//                       /opt/data/workspace/backend"
//                    → "Deploy still blocked on VERCEL_TOKEN."
//                    → "task_lngbpbh19kbvv7w3lxhp unblocked."
//
// The web never showed any of it — web/src/lib/md.ts (`scrubIds`) cleans these
// exact strings at render — which is precisely why it survived: the leak is
// invisible in the browser and complete in the JSON. The API is the public
// surface, so the scrub belongs here too.
//
// Same rule as everywhere else in this file: the stored bytes never change,
// members and agents read the original, and only `req.spectator` gets this.

// What a title becomes when the scrub removes all of it — a card whose title
// was nothing but a container path still has to render as something.
export const SCRUBBED_TITLE_FALLBACK = "Untitled";

/**
 * A title is prose that has to stay on one line. Same vocabulary as
 * `scrubPublicBody`, then newlines collapse to spaces. An empty title in,
 * empty title out — we do not invent one — but a title the scrub empties
 * becomes the fallback rather than a blank card.
 */
export function scrubPublicTitle(text: string | null | undefined): string {
  const raw = String(text ?? "");
  if (!raw.trim()) return raw;
  const cleaned = scrubPublicBody(raw).replace(/\s+/g, " ").trim();
  return cleaned || SCRUBBED_TITLE_FALLBACK;
}

/**
 * A filename is not prose: it has no sentences to tidy and its digests and
 * hex runs are part of its identity (`auditor_manifest_sha256.json` must stay
 * that, not become `auditor_manifest_.json`). So a name only loses its mount
 * point — the same rewrite the file-serve path already applies to a public
 * read of a text deliverable.
 */
export function scrubPublicName(name: string | null | undefined): string {
  const raw = String(name ?? "");
  if (!raw) return raw;
  const cleaned = scrubInternalPaths(raw).trim();
  return cleaned || "file";
}

// Copy a row with the named string fields rewritten. Only strings are touched,
// so a null `conversationName` stays null and a numeric field is left alone.
function scrubFields<T extends Record<string, unknown>>(
  row: T,
  titles: readonly string[],
  bodies: readonly string[],
): T {
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = { ...row };
  for (const k of titles) if (typeof out[k] === "string") out[k] = scrubPublicTitle(out[k] as string);
  for (const k of bodies) if (typeof out[k] === "string") out[k] = scrubPublicBody(out[k] as string);
  return out as T;
}

/** Every authored text field on a task row, as the public identity may read it. */
export function spectatorTaskText<T extends Record<string, unknown>>(task: T): T {
  return scrubFields(task, ["title"], ["bodyMd", "description"]);
}

/** The same for a goal row (`GET /goals`, `GET /goals/:id`). */
export function spectatorGoalText<T extends Record<string, unknown>>(goal: T): T {
  return scrubFields(goal, ["title"], ["bodyMd", "description"]);
}

/**
 * A "Needs you" item. `detail` is the worst of the three: for a failed
 * workflow it is the run's raw `errorText`, and for a broken connector the
 * provider's `lastError`.
 */
export function spectatorNeedsYouItem<T extends Record<string, unknown>>(item: T): T {
  return scrubFields(item, ["title"], ["detail"]);
}

// The text fields of a file-directory row. Named explicitly rather than
// indexed, because the row is a declared interface in routes/files.ts, not a
// bag — a new text column has to be added here deliberately.
export interface PublicFileFields {
  name?: string;
  description?: string | null;
  taskTitle?: string | null;
  conversationName?: string | null;
}

/**
 * A row of the file directory. `key` and `url` are storage paths we minted
 * (`u/<rand>/<name>`), not container paths, so they are left alone; the
 * borrowed text — the attachment's own name, the card it hangs off, the
 * channel it was posted in — is not.
 */
export function spectatorFileRow<T extends PublicFileFields>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  if (typeof out.name === "string") out.name = scrubPublicName(out.name);
  if (typeof out.description === "string") out.description = scrubPublicBody(out.description);
  if (typeof out.taskTitle === "string") out.taskTitle = scrubPublicTitle(out.taskTitle);
  if (typeof out.conversationName === "string") {
    out.conversationName = scrubPublicTitle(out.conversationName);
  }
  return out;
}
