// ─────────────────────────────────────────────────────────────────────────
// Guard for LLM proposals that become user-visible rows.
//
// The planner prompts hand the model a JSON TEMPLATE to copy the shape of:
//   {"goals":[{"title":"...","description":"what done looks like", …,
//              "rationale":"why this is the next move for the mission"}]}
// A weak model (FreeLLMAPI `auto` routes to whatever is free today) sometimes
// copies the template's FILLER as well as its shape and returns the example
// verbatim. That parses cleanly against the zod schema — the strings are the
// right type and length — so it used to sail straight into the board.
//
// Live proof (14 Sep 2026): goal_p6ohf87smk1b70if7rgs was created with the
// title "..." and the body "what done looks like\n\n_Why now: why this is the
// next move for the mission_". A goal nobody wrote, on a real customer's board,
// which the goal planner then dutifully decomposed into tasks.
//
// Schema validation cannot catch this; only content validation can. Everything
// here is pure and side-effect free so each call site can log its own rejection
// line and decide whether to drop the row or retry the model.
// ─────────────────────────────────────────────────────────────────────────

// The filler strings that appear in the prompt templates, lifted verbatim from
// lib/mission-planner.ts and lib/planner.ts. If you edit a prompt's example
// JSON, add the new filler here — that is the whole contract of this list.
export const PLACEHOLDER_PHRASES = [
  "what done looks like",
  "why this is the next move for the mission",
  "why this task + why this owner",
  "why this task",
  "why this owner",
  "exact project title or empty",
  "exact title of an existing project",
  "why now",
  "title",
  "description",
  "rationale",
  "handle",
  "assignee",
];

// Markdown scaffolding the planners wrap a body in (`_Why now: …_`), plus the
// ellipsis the templates use for "your text here". Stripped before comparison
// so "..." and "_..._" are the same nothing.
const MARKDOWN = /[*_~`>#|\[\]()]/g;

/** Lowercase, drop markdown/punctuation, collapse whitespace. */
function normalize(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(MARKDOWN, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/[.,;:!?"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Letters only — the yardstick for "is there any real content in here". */
const letters = (s: string): string => s.replace(/[^a-z0-9]/gi, "");

/**
 * True when `text` is nothing but (or overwhelmingly) the prompt's own filler.
 *
 * Not an exact-match test: the live junk body was two placeholders glued
 * together with the `_Why now:_` wrapper, so we strip every known phrase and
 * ask how much real content is left. A genuine body that happens to contain
 * the words "what done looks like" keeps plenty of residue and passes.
 */
export function isPlaceholderText(text: string): boolean {
  const norm = normalize(text);
  if (!norm) return true;
  let residue = norm;
  for (const phrase of PLACEHOLDER_PHRASES) {
    residue = residue.split(phrase).join(" ");
  }
  const before = letters(norm).length;
  const after = letters(residue).length;
  if (!before) return true;
  // Less than half the characters survived the filler strip → it IS the filler.
  return after / before < 0.5;
}

export type ProposalVerdict = { ok: true } | { ok: false; reason: string };

export interface ProposalLimits {
  /** Minimum title length. Default 12 — shorter than that is never a real outcome. */
  minTitleChars?: number;
  /** Maximum title length, matching the row's column budget. Default 300. */
  maxTitleChars?: number;
  /** Minimum words in a title. Default 3 — "..." and "Do it" are not proposals. */
  minTitleWords?: number;
  /** Minimum body length. Default 0 = body optional (but still filler-checked). */
  minBodyChars?: number;
}

const words = (s: string): string[] => normalize(s).split(" ").filter(Boolean);

/** Validate a title on its own. Exported for call sites with no body. */
export function checkTitle(title: string, limits: ProposalLimits = {}): ProposalVerdict {
  const { minTitleChars = 12, maxTitleChars = 300, minTitleWords = 3 } = limits;
  const t = String(title ?? "").trim();
  if (t.length < minTitleChars) return { ok: false, reason: `title too short (${t.length} < ${minTitleChars} chars)` };
  if (t.length > maxTitleChars) return { ok: false, reason: `title too long (${t.length} > ${maxTitleChars} chars)` };
  if (!/[a-z]/i.test(t)) return { ok: false, reason: "title has no letters" };
  const w = words(t);
  if (w.length < minTitleWords) return { ok: false, reason: `title has ${w.length} word(s), needs ${minTitleWords}` };
  if (isPlaceholderText(t)) return { ok: false, reason: `title is prompt filler ("${t.slice(0, 60)}")` };
  return { ok: true };
}

/** Validate a body on its own. `minBodyChars` 0 means "optional, but not filler". */
export function checkBody(body: string, limits: ProposalLimits = {}): ProposalVerdict {
  const { minBodyChars = 0 } = limits;
  const b = String(body ?? "").trim();
  if (b.length < minBodyChars) return { ok: false, reason: `body too short (${b.length} < ${minBodyChars} chars)` };
  if (!b) return { ok: true }; // empty and allowed
  if (isPlaceholderText(b)) return { ok: false, reason: `body is prompt filler ("${b.slice(0, 60)}")` };
  return { ok: true };
}

/**
 * Validate one proposed user-visible row (a goal, a task) before it is
 * inserted. Returns the FIRST failure so the caller can log one clear reason.
 */
export function checkProposal(
  proposal: { title: string; body?: string },
  limits: ProposalLimits = {},
): ProposalVerdict {
  const title = checkTitle(proposal.title, limits);
  if (!title.ok) return title;
  return checkBody(proposal.body ?? "", limits);
}

// A goal proposed from the workspace mission is a days-of-work outcome: it must
// carry a real title AND a real body (what done looks like + why now).
export const GOAL_LIMITS: ProposalLimits = { minTitleChars: 12, maxTitleChars: 300, minTitleWords: 3, minBodyChars: 80 };

// A planned task's description is optional in the schema (the title plus the
// routing rationale often carry it), so the body is filler-checked but not
// length-gated. The title bar is the same.
export const TASK_LIMITS: ProposalLimits = { minTitleChars: 12, maxTitleChars: 200, minTitleWords: 3, minBodyChars: 0 };

// Appended to a planner prompt when the first completion came back as nothing
// but template filler. One retry, explicitly naming the failure.
export const STRICTER_RETRY_NOTE = [
  "Your previous reply copied the EXAMPLE TEXT from the template instead of writing real content.",
  'Do NOT return the literal strings "...", "what done looks like", "why this is the next move for the mission", or any other placeholder from the example.',
  "Write specific, concrete text about THIS workspace's mission, projects and goals. Every title must be a full outcome of at least a few words; every description must say what done actually looks like here.",
].join("\n");
