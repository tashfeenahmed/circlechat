// Which artifact(s) on a task ARE the deliverable?
//
// Why this exists. The verification judge used to take the LAST-ATTACHED
// readable artifact ("pick the latest readable, substantive deliverable"). In
// practice agents ship the real work FIRST and then attach their own paperwork
// — a verification report, an audit log, a UX-research write-up — so the judge
// read the paperwork and failed the card with things like "this is a UX
// research document, not an interactive dashboard". Two live cards
// (task_qqfu1z2w5p2nj2ntw7gs, task_pwlrihqckbhcdhwo9flm) failed exactly that
// way with a perfectly good dashboard.html sitting on the task.
//
// So: rank the artifacts against the BRIEF instead of the clock.
//   1. collapse each name to one version, skipping a tiny newer version when a
//      substantial older one exists (live had dashboard.html v1=292 B, v3=189 B
//      and v2/4/5/6=13,915 B — the 189-byte version must never be judged);
//   2. score each name: does its extension match the kind of artifact the task
//      asked for, does its name echo the title, how substantial is it, and does
//      it look like paperwork ABOUT the work (verification/audit/report/notes/
//      manifest/checksum) rather than the work;
//   3. paperwork is only demoted when the brief did not ask for it — a task
//      that literally says "write a research report" still ranks report.md
//      first;
//   4. return the whole ranked SET, so the judge scores the deliverable set
//      against the brief rather than one arbitrarily-chosen file.
//
// Everything here is pure (no DB, no storage) so it is fully unit-testable.

export interface DeliverableCandidate {
  id: string;
  name: string;
  contentType: string;
  size: number;
  version: number;
  createdAt: Date;
}

// A version this small is a stub. When a LARGER version of the same name
// exists, the stub is skipped rather than treated as "the latest".
export const MIN_PRIMARY_BYTES = 1024;

// Tokens that mark a file as paperwork ABOUT the work. Matched on word
// boundaries inside the (hyphen/underscore/dot-separated) file name.
const ANCILLARY_TOKENS = [
  "verification",
  "verifications",
  "verify",
  "verifying",
  "verified",
  "reverification",
  "revalidation",
  "validation",
  "validated",
  "audit",
  "audits",
  "audited",
  "qa",
  "qc",
  "testreport",
  "report",
  "reports",
  "reporting",
  "research",
  "notes",
  "note",
  "manifest",
  "manifests",
  "checklist",
  "checklists",
  "checksum",
  "checksums",
  "hashes",
  "sha256",
  "sha256sums",
  "sha1sums",
  "md5sums",
  "changelog",
  "readme",
  "summary",
  "summaries",
  "log",
  "logs",
  "logfile",
  "postmortem",
  "retro",
  "handoff",
  "handover",
  "signoff",
  "status",
  "evidence",
  "proof",
  "confirmation",
  "completion",
  "findings",
  "plan",
  "planning",
  "todo",
  "scratch",
  "draft",
];

// Extension groups keyed by the kind of thing a brief can ask for.
const KIND_EXTENSIONS: Record<string, string[]> = {
  web: ["html", "htm"],
  code: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "sh", "bash", "go", "rs", "rb", "php", "java", "sql", "css"],
  doc: ["md", "markdown", "txt", "rst", "pdf", "doc", "docx"],
  data: ["csv", "json", "tsv", "xlsx", "yaml", "yml", "ndjson", "parquet"],
  design: ["png", "jpg", "jpeg", "svg", "gif", "webp", "fig", "sketch"],
  slides: ["ppt", "pptx", "key"],
};

// Brief phrases → the kind of artifact they ask for. Order matters only in
// that every match is unioned; a brief can legitimately want two kinds.
const KIND_CUES: Array<{ kind: keyof typeof KIND_EXTENSIONS & string; re: RegExp }> = [
  { kind: "web", re: /\b(dashboard|prototype|landing\s*page|web\s*app|webapp|web\s*page|webpage|single[-\s]?page|interactive|ui|front[-\s]?end|micro[-\s]?site|website|site|mock-?up|wireframe|viewer|explorer|visuali[sz]ation)\b/i },
  { kind: "code", re: /\b(script|cli|tool|library|module|endpoint|api|function|migration|parser|scraper|crawler|pipeline|patch|refactor|implement|integration)\b/i },
  { kind: "doc", re: /\b(report|research|analysis|memo|write[-\s]?up|writeup|brief|spec|specification|documentation|docs|guide|playbook|policy|proposal|summary|plan|roadmap|strategy|review|audit|assessment)\b/i },
  { kind: "data", re: /\b(dataset|data\s*set|spreadsheet|csv|export|table|list of|inventory|catalog|catalogue|feed|extract)\b/i },
  { kind: "design", re: /\b(design|diagram|chart|graphic|logo|illustration|screenshot|figure|icon)\b/i },
  { kind: "slides", re: /\b(deck|slides|presentation|pitch)\b/i },
];

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "by", "from", "at",
  "build", "create", "make", "write", "add", "produce", "deliver", "ship", "set", "up", "our",
  "new", "using", "use", "into", "that", "this", "it", "is", "are", "be", "as", "per",
]);

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec((name || "").trim());
  return m ? m[1].toLowerCase() : "";
}

function nameTokens(name: string): string[] {
  return (name || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^\d+$/.test(t));
}

function briefTokens(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

// Which artifact kinds does this brief ask for? The TITLE decides whenever it
// carries a cue — the title is what names the deliverable ("Build an
// interactive governance dashboard"), while the body is full of incidental
// vocabulary ("report on the feeds", "review the data") that would otherwise
// make every .md look like a requested deliverable. The body is only consulted
// when the title says nothing. Empty when neither gives a usable cue — then
// extension matching contributes nothing and the other signals decide.
export function expectedKinds(title: string, bodyMd: string): string[] {
  const fromTitle: string[] = [];
  for (const cue of KIND_CUES) if (cue.re.test(title || "")) fromTitle.push(cue.kind);
  if (fromTitle.length) return fromTitle;
  const fromBody: string[] = [];
  for (const cue of KIND_CUES) if (cue.re.test(bodyMd || "")) fromBody.push(cue.kind);
  return fromBody;
}

function expectedExtensions(kinds: string[]): Set<string> {
  const out = new Set<string>();
  for (const k of kinds) for (const e of KIND_EXTENSIONS[k] ?? []) out.add(e);
  return out;
}

// Only these extensions can be paperwork. A report ABOUT the work is prose:
// it arrives as .md/.txt/SHA256SUMS/manifest.json, never as the running
// artifact itself. Gating on the extension is what keeps a legitimately-named
// deliverable ("final-dashboard.html", "audit-tool.ts", "status-board.html")
// out of the paperwork bucket no matter which tokens its name happens to use.
const PAPERWORK_EXTENSIONS = new Set([
  "", // SHA256SUMS, CHECKSUMS, NOTES — no extension at all
  "md",
  "markdown",
  "txt",
  "text",
  "rst",
  "log",
  "json",
  "pdf",
  "doc",
  "docx",
]);

// A brief only "asks for" paperwork when it asks for it as a DELIVERABLE —
// "write a competitor research report", "produce an audit". Merely USING the
// vocabulary does not count, and that distinction is the whole bug: live task
// task_9533y8685y7zginrepvk is titled "Deploy and Verify the Live Dashboard"
// and its body says "Re-verification complete … both implemented and verified",
// so the old rule (any brief token forgives the matching name token) forgave
// "verify" and "verification" and handed the judge four of the agent's own
// verification write-ups alongside dashboard.html.
const DELIVERABLE_VERBS =
  "write|writing|produce|producing|deliver|delivering|create|creating|draft|drafting|compile|compiling|prepare|preparing|provide|providing|submit|submitting|generate|generating|publish|publishing|author|authoring|attach|attaching|include|including";

/**
 * The paperwork tokens this brief genuinely asked for as a deliverable. Pure.
 * A token qualifies when a producing verb appears within a short span before
 * it in the same sentence ("write the Q3 audit report" → audit, report).
 */
export function paperworkAskedFor(title: string, bodyMd: string): Set<string> {
  const hay = `${title || ""}\n${bodyMd || ""}`.toLowerCase();
  const out = new Set<string>();
  for (const tok of ANCILLARY_TOKENS) {
    const re = new RegExp(`\\b(?:${DELIVERABLE_VERBS})\\b[^.\\n]{0,40}?\\b${tok}s?\\b`);
    if (re.test(hay)) out.add(tok);
  }
  return out;
}

// Does this file name read as paperwork about the work? `asked` is what the
// brief explicitly requested as a deliverable (see paperworkAskedFor): a brief
// that says "write the audit report" makes audit-report.md the deliverable, not
// paperwork, so those tokens are forgiven.
// Over-flagging is cheap: when EVERY candidate looks like paperwork the filter
// falls back to the full ranked list, so the worst case is that the ordinary
// signals (requested extension, title echo, size) decide on their own.
export function isAncillaryName(name: string, asked: Set<string>): boolean {
  if (!PAPERWORK_EXTENSIONS.has(extensionOf(name))) return false;
  return nameTokens(name).some((t) => ANCILLARY_TOKENS.includes(t) && !asked.has(t));
}

// Lines that are the agent ticking its own boxes rather than the work: bare
// hashes, checkmarks, "200 OK"/HTTP status roll-calls, "VERIFIED"/"MATCH"
// stamps. A file that is MOSTLY these is a self-written report whatever it is
// called — live had `backend-full-verification-2026-09-13.md`, 3 KB of
// "27/27 endpoints 200 OK" and "4/4 footer hashes MATCH", and the judge's pass
// rationale quoted it back as if it were evidence.
const PAPERWORK_LINE_RES: RegExp[] = [
  /\b[0-9a-f]{32,64}\b/i, // md5/sha1/sha256 digests
  /^[\s>*\-+#|]*[\u2705\u2714\u2713\u274c\u2717\u2716\u2718]/u, // leading ✅ ✔ ✓ ❌ ✗ ✘
  /[\u2705\u2714\u274c]/u, // a checkmark/cross anywhere on the line
  /\b(?:200\s*OK|HTTP\/\d(?:\.\d)?\s*200|status[:=]\s*200)\b/i,
  /\b(?:verified|verification|re-?verified|validated|confirmed|matches?|match(?:ed)?|pass(?:ed)?|ok)\b\s*[.:!]?\s*$/i,
  /^\s*\d+\s*\/\s*\d+\b/, // "27/27 endpoints", "4/4 hashes"
];

/** Minimum non-empty lines before the content check is allowed to decide. */
const PAPERWORK_MIN_LINES = 4;

/**
 * Pure: does this file's BODY read as the agent's own report about the work
 * (mostly hashes / checkmarks / "200 OK" / "verified" lines) rather than the
 * work itself? Deliberately conservative — it needs a real majority, and the
 * caller only ever uses it to drop a file when a non-paperwork deliverable is
 * also on the task.
 */
export function looksLikePaperworkText(text: string): boolean {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < PAPERWORK_MIN_LINES) return false;
  let marked = 0;
  for (const line of lines) if (PAPERWORK_LINE_RES.some((re) => re.test(line))) marked++;
  return marked / lines.length > 0.5;
}

// Collapse each distinct name to the single version that should be judged.
// Highest version wins, EXCEPT that a version under MIN_PRIMARY_BYTES is
// skipped whenever a larger version of the same name exists.
export function collapseVersions(rows: readonly DeliverableCandidate[]): DeliverableCandidate[] {
  const byName = new Map<string, DeliverableCandidate[]>();
  for (const r of rows) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }
  const out: DeliverableCandidate[] = [];
  for (const list of byName.values()) {
    const sorted = [...list].sort((a, b) => b.version - a.version);
    const substantial = sorted.filter((r) => r.size >= MIN_PRIMARY_BYTES);
    out.push(substantial.length ? substantial[0] : sorted[0]);
  }
  return out;
}

export interface ScoredDeliverable {
  row: DeliverableCandidate;
  score: number;
  ancillary: boolean;
  reasons: string[];
}

// Rank the collapsed candidates against the brief. Higher score = more likely
// to BE the deliverable. Deterministic: ties break on size then recency then id
// so the same inputs always produce the same order (important — the re-judge
// guard keys off the resulting set).
export function scoreDeliverables(
  rows: readonly DeliverableCandidate[],
  title: string,
  bodyMd: string,
): ScoredDeliverable[] {
  const collapsed = collapseVersions(rows);
  if (!collapsed.length) return [];
  const kinds = expectedKinds(title, bodyMd);
  const wantExt = expectedExtensions(kinds);
  const asked = paperworkAskedFor(title, bodyMd);
  const titleToks = briefTokens(title);
  const maxSize = Math.max(...collapsed.map((r) => r.size), 1);

  const scored = collapsed.map((row) => {
    const reasons: string[] = [];
    let score = 0;
    const ext = extensionOf(row.name);
    if (wantExt.size && ext && wantExt.has(ext)) {
      score += 3;
      reasons.push(`extension .${ext} matches the requested ${kinds.join("/")} deliverable`);
    }
    const toks = nameTokens(row.name);
    const echo = toks.filter((t) => titleToks.has(t)).length;
    if (echo) {
      score += Math.min(1, echo * 0.5);
      reasons.push("name echoes the task title");
    }
    // Size, normalized and compressed — bigger is weakly better, never decisive.
    score += 1.2 * (Math.log10(row.size + 1) / Math.log10(maxSize + 1));
    const ancillary = isAncillaryName(row.name, asked);
    if (ancillary) {
      score -= 2.5;
      reasons.push("name reads as paperwork about the work, not the work");
    }
    if (row.size < MIN_PRIMARY_BYTES) {
      score -= 1;
      reasons.push(`only ${row.size} B`);
    }
    return { row, score, ancillary, reasons };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.row.size - a.row.size ||
      (b.row.createdAt?.getTime?.() ?? 0) - (a.row.createdAt?.getTime?.() ?? 0) ||
      (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
  );
  return scored;
}

export interface DeliverableSelection {
  /** The single artifact the verdict is recorded against. Null when there is nothing to judge. */
  primary: DeliverableCandidate | null;
  /** The artifacts to show the judge, primary first. */
  set: DeliverableCandidate[];
  /** Ranked view including what was demoted, for logging/debugging. */
  ranked: ScoredDeliverable[];
  /**
   * Paperwork that was EXCLUDED from the judged set because real work exists.
   * The judge is told these names — "the agent's own reports about the work,
   * not evidence" — so it can see what was attached without reading it.
   */
  paperwork: DeliverableCandidate[];
}

// How many artifacts the judge is shown at once. More than this and the
// prompt is mostly context-stuffing; the tail is always the lowest-ranked.
export const MAX_JUDGED_ARTIFACTS = 4;

// The deliverable SET for a task: the highest-ranked artifact plus the other
// plausible deliverables, paperwork dropped whenever real work exists.
export function selectDeliverables(
  rows: readonly DeliverableCandidate[],
  title: string,
  bodyMd: string,
): DeliverableSelection {
  const ranked = scoreDeliverables(rows, title, bodyMd);
  if (!ranked.length) return { primary: null, set: [], ranked, paperwork: [] };
  // A stub is never the deliverable while something substantial is on the
  // task, whatever its extension says. (A 500-byte manifest.json must not beat
  // a 4 KB write-up just because the brief mentioned an inventory.)
  const big = ranked.filter((s) => s.row.size >= MIN_PRIMARY_BYTES);
  const bySize = big.length ? big : ranked;
  // Drop paperwork entirely when at least one non-paperwork artifact exists —
  // the judge should not be looking at a verification report while deciding
  // whether the dashboard was built.
  const substantive = bySize.filter((s) => !s.ancillary);
  const pool = substantive.length ? substantive : bySize;
  // When real work exists the paperwork is not merely ranked last — it leaves
  // the judged set entirely and is only NAMED in the prompt.
  const paperwork = substantive.length ? ranked.filter((s) => s.ancillary).map((s) => s.row) : [];
  const set = pool.slice(0, MAX_JUDGED_ARTIFACTS).map((s) => s.row);
  return { primary: set[0] ?? null, set, ranked, paperwork };
}

// Stable identity for a deliverable SET. Two judge runs over the same set of
// artifact versions produce the same key, which is what lets the re-judge guard
// say "nothing changed, do not call the judge again".
export function deliverableSetKey(rows: readonly DeliverableCandidate[]): string {
  return rows
    .map((r) => `${r.id}:${r.version}:${r.size}`)
    .sort()
    .join("|");
}
