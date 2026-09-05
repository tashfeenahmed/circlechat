import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { embed, cosine, embeddingsEnabled } from "./embeddings.js";
import { findNearDuplicate } from "./text-similarity.js";

// ─────────────────────────── Shared project memory ───────────────────────────
// A file-based "blackboard" the agents form and manage themselves: multiple
// markdown files per project under <mount>/projects/<slug>/, all on the shared
// /workspace mount every agent (and this container) sees. It complements the
// single human-pinned BRIEF.md and the DB-backed `team` memory block with a
// MULTI-FILE, per-project layer the team writes to and references across turns.
//
// Design (grounded in Cline/Roo "Memory Bank" + Claude Code's index-then-fetch
// + Letta's append-safe / owner-for-rewrites concurrency rule + the classic
// blackboard pattern; see docs/shared-project-context-md-layer.md):
//   • Layout: /workspace/projects/<slug>/{brief,status,decisions,changelog,…}.md
//   • Index : a per-turn DERIVED map (never drifts) injected into every prompt;
//             topic files are injected only when relevant (trigger-gated) or on
//             demand via the agent's shell — keeping the token budget bounded.
//   • Write : append is the safe default (concurrency-safe, attributed); a full
//             rewrite is owner-gated (the frontmatter `owner` must match).
//   • Trust : every append carries a `## <date> · @handle` provenance header;
//             frontmatter records owner + summary + triggers.
// Every read is fail-safe: a missing mount/dir just yields an empty layer.

// Resolved per-call (not at module load) so tests can point it at a temp dir.
function workspaceMount(): string {
  return process.env.CC_WORKSPACE_MOUNT || "/workspace";
}

export function projectsRoot(): string {
  return `${workspaceMount().replace(/\/$/, "")}/projects`;
}

const SLUG_MAX = 48;
const FILE_NAME_MAX = 48;
// A single tracked file is capped so one runaway append can't blow the budget
// or the disk; hitting it tells the agent to compact via mode:"replace".
export const PROJECT_FILE_MAX_CHARS = 20000;
// Injection budget (mirrors the knowledge limits in context.ts).
const INDEX_MAX_CHARS = 2000;
const FILES_MAX_COUNT = 4;
const FILE_INJECT_MAX_CHARS = 1600;
const FILES_TOTAL_MAX_CHARS = 5000;
// Bound the index scan so a pathological tree can't stall a prompt build.
const MAX_PROJECTS = 40;
const MAX_FILES_PER_PROJECT = 24;

export interface ProjectFileMeta {
  summary: string;
  owner: string;
  updatedBy: string;
  triggers: string[];
  always: boolean;
}

export interface ProjectFileInfo extends ProjectFileMeta {
  name: string; // e.g. "status.md"
  path: string; // absolute path on the shared mount
  size: number;
  mtimeMs: number;
  // Body lead (provenance headers stripped), captured during the index read so
  // the semantic matcher has a representative text to embed without re-reading.
  snippet?: string;
}

export interface ProjectInfo {
  slug: string;
  owner: string; // owner of brief.md if present, else first owner seen
  files: ProjectFileInfo[];
}

// ─────────────────────────── slug / name hygiene ───────────────────────────

export function slugifyProject(name: string): string {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, SLUG_MAX);
}

// Normalise an agent-supplied file name to a safe, flat `*.md` basename. No
// subdirs, no traversal — the project slug is the only directory level.
export function sanitizeProjectFileName(name: string | undefined, fallback = "log.md"): string {
  let n = (name || "").toLowerCase().trim();
  n = n.split(/[\\/]/).pop() ?? n; // drop any path components
  n = n.replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+/, "");
  if (!n) n = fallback;
  if (!/\.(md|txt)$/.test(n)) n = `${n.replace(/\.+$/, "")}.md`;
  return n.slice(0, FILE_NAME_MAX);
}

// ─────────────────────────── frontmatter (yaml) ───────────────────────────

function normalizeMeta(raw: unknown): ProjectFileMeta {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const triggers = Array.isArray(m.triggers)
    ? m.triggers.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : [];
  return {
    summary: typeof m.summary === "string" ? m.summary.trim() : "",
    owner: typeof m.owner === "string" ? m.owner.trim().replace(/^@/, "") : "",
    updatedBy:
      typeof m.updated_by === "string"
        ? m.updated_by.trim().replace(/^@/, "")
        : typeof m.updatedBy === "string"
          ? m.updatedBy.trim().replace(/^@/, "")
          : "",
    triggers,
    always: m.always === true || m.always === "true",
  };
}

// Split + parse a file's optional YAML frontmatter. Fail-safe: a malformed or
// missing frontmatter just yields empty meta and the whole text as the body.
export function parseProjectFile(raw: string): { meta: ProjectFileMeta; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw ?? "");
  if (!m) return { meta: normalizeMeta({}), body: (raw ?? "").trim() };
  let parsed: unknown = {};
  try {
    parsed = parseYaml(m[1]) ?? {};
  } catch {
    parsed = {};
  }
  return { meta: normalizeMeta(parsed), body: (m[2] ?? "").trim() };
}

export function serializeProjectFile(meta: ProjectFileMeta, body: string): string {
  const fm: Record<string, unknown> = {};
  if (meta.summary) fm.summary = meta.summary;
  if (meta.owner) fm.owner = meta.owner;
  if (meta.updatedBy) fm.updated_by = meta.updatedBy;
  if (meta.triggers && meta.triggers.length) fm.triggers = meta.triggers;
  if (meta.always) fm.always = true;
  const head = Object.keys(fm).length ? `---\n${stringifyYaml(fm).trim()}\n---\n\n` : "";
  return `${head}${body.trim()}\n`;
}

// ─────────────────────────── entries (append log) ───────────────────────────
// Every append writes `## <date> · @handle\n<note>`. Split a body into the
// free-form head (anything before the first provenance header — e.g. a brief
// written via mode:"replace") and the dated entries, oldest first.
const ENTRY_HEADER_RE = /^## [^\n]*? · @[a-z0-9][a-z0-9._-]*[ \t]*$/im;
const ENTRY_SPLIT_RE = /(?=^## [^\n]*? · @[a-z0-9][a-z0-9._-]*[ \t]*$)/im;

export function splitEntries(body: string): { head: string; entries: string[] } {
  const text = (body || "").trim();
  if (!text) return { head: "", entries: [] };
  const first = ENTRY_HEADER_RE.exec(text);
  if (!first) return { head: text, entries: [] };
  const head = text.slice(0, first.index).trim();
  const rest = text.slice(first.index);
  // Split on every header (the lookahead keeps the header with its entry).
  const parts = rest.split(new RegExp(ENTRY_SPLIT_RE.source, "gim")).map((e) => e.trim()).filter(Boolean);
  return { head, entries: parts };
}

// The note text of an entry (header line dropped) — what dedupe compares.
function entryNote(entry: string): string {
  return entry.replace(/^## [^\n]*\n?/, "").trim();
}

// Append dedupe: an incoming note ≥ this similar to one of the last
// DEDUPE_WINDOW entries is a restatement, not new state. Live status.md had
// "Self-hosted HLS relay verified live" appended four times by two agents in
// three hours.
export const APPEND_DEDUPE_THRESHOLD = 0.85;
const DEDUPE_WINDOW = 12;

// Rolling compaction so an append-only status log can't grow without bound
// (live: 20 KB / 308 lines / 90 dated entries, re-injected into every prompt).
// After an append, when the log has more than KEEP_ENTRIES entries OR the body
// is over COMPACT_AT_CHARS, the OLDEST entries are moved out to
// <project>/archive/<file> until it fits (never below MIN_KEEP entries). The
// head (brief text) is always kept.
export const KEEP_ENTRIES = 25;
export const COMPACT_AT_CHARS = 8000;
const MIN_KEEP = 8;

export function compactEntries(
  head: string,
  entries: string[],
): { body: string; archived: string[] } {
  const kept = [...entries];
  const archived: string[] = [];
  const render = () => [head, ...kept].filter(Boolean).join("\n\n");
  while (kept.length > MIN_KEEP && (kept.length > KEEP_ENTRIES || render().length > COMPACT_AT_CHARS)) {
    archived.push(kept.shift() as string);
  }
  return { body: render(), archived };
}

// ─────────────────────────── pure write logic ───────────────────────────

export type ProjectWriteMode = "append" | "replace";

// Compute the new file content for a write. Pure (no fs) so it's unit-testable.
// `current` is the existing file text, or null when creating the file.
//   • append  — add a `## <date> · @handle` provenance entry to the body. Always
//               allowed (this is the concurrency-safe path).
//   • replace — overwrite the body wholesale. OWNER-GATED: rejected when the
//               file already has a different `owner`.
// Returns the text to write, or a teaching error string for the agent.
export function applyProjectWrite(
  current: string | null,
  p: {
    mode: ProjectWriteMode;
    note: string;
    summary?: string;
    triggers?: string[];
    always?: boolean;
    actorHandle: string;
    dateLabel: string;
  },
): { content: string; archived?: string[] } | { error: string } {
  const note = (p.note ?? "").trim();
  if (!note) return { error: "project_note: note is empty — nothing to record." };
  const handle = (p.actorHandle || "agent").replace(/^@/, "");
  const existing = current != null ? parseProjectFile(current) : null;
  const meta: ProjectFileMeta = existing
    ? { ...existing.meta }
    : { summary: "", owner: handle, triggers: [], always: false, updatedBy: handle };

  if (p.mode === "replace") {
    if (existing && meta.owner && meta.owner !== handle) {
      return {
        error:
          `project_note: "${meta.owner}" owns this file — you can't replace it. ` +
          `Use mode:"append" to add your update to it (always allowed), or ask @${meta.owner} to rewrite it.`,
      };
    }
    if (!meta.owner) meta.owner = handle;
  }

  // Optional metadata the agent can set on either mode.
  if (typeof p.summary === "string" && p.summary.trim()) meta.summary = p.summary.trim().slice(0, 200);
  if (Array.isArray(p.triggers) && p.triggers.length) {
    const incoming = p.triggers.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    meta.triggers = Array.from(new Set([...(meta.triggers ?? []), ...incoming])).slice(0, 12);
  }
  if (typeof p.always === "boolean") meta.always = p.always;
  meta.updatedBy = handle;

  if (p.mode === "replace") {
    if (note.length > PROJECT_FILE_MAX_CHARS) {
      return {
        error:
          `project_note: this file would exceed its ${PROJECT_FILE_MAX_CHARS}-char limit (${note.length}). ` +
          `Rewrite it concisely keeping only what still matters.`,
      };
    }
    return { content: serializeProjectFile(meta, note) };
  }

  // ── append ──
  const { head, entries } = splitEntries(existing?.body ?? "");
  // Near-duplicate of a recent entry → refuse (teaching error). Compare the
  // note against the last DEDUPE_WINDOW entries regardless of author: two
  // agents recording the same fact is still one fact.
  const recent = entries.slice(-DEDUPE_WINDOW).reverse().map((e) => ({ bodyMd: entryNote(e), entry: e }));
  const dup = findNearDuplicate(note, recent, APPEND_DEDUPE_THRESHOLD);
  if (dup) {
    const who = /· @([a-z0-9._-]+)/i.exec(dup.candidate.entry)?.[1];
    return {
      error:
        `project_note skipped: this note is a near-duplicate (${Math.round(dup.score * 100)}%) of an entry already in the file` +
        `${who ? ` (by @${who})` : ""}. The tracker records each fact ONCE — don't re-append a status that's already there. ` +
        `Only write when something actually changed, and say what changed.`,
    };
  }
  if (note.length > PROJECT_FILE_MAX_CHARS / 2) {
    return {
      error:
        `project_note: a single entry can't exceed ${PROJECT_FILE_MAX_CHARS / 2} chars (${note.length}). ` +
        `Record the durable fact in a few lines; put long-form material in a /workspace file and reference it.`,
    };
  }
  const { body, archived } = compactEntries(head, [...entries, `## ${p.dateLabel} · @${handle}\n${note}`]);
  if (body.length > PROJECT_FILE_MAX_CHARS) {
    return {
      error:
        `project_note: this file would exceed its ${PROJECT_FILE_MAX_CHARS}-char limit (${body.length}). ` +
        `Compact it with mode:"replace" — rewrite it concisely keeping only what still matters — instead of appending more.`,
    };
  }
  return archived.length
    ? { content: serializeProjectFile(meta, body), archived }
    : { content: serializeProjectFile(meta, body) };
}

// ─────────────────────────── per-path write serialization ───────────────────
// In-process mutex so two concurrent turns in the same process don't clobber a
// read-modify-write on the same file. Append still uses read-modify-write (it
// also manages frontmatter), so the lock matters; cross-process contention is
// rare (owner-gated rewrites, low frequency) and tolerated.
const writeChains = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  writeChains.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

function dateLabel(): string {
  // YYYY-MM-DD HH:MM in UTC — stable, no locale surprises.
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

// Apply a project write to disk. Creates <mount>/projects/<slug>/<file>,
// enforces owner-gating + caps via applyProjectWrite, then regenerates the
// on-disk INDEX.md (best-effort) so agents browsing the mount by shell see the
// same map the prompt injects. Returns the relative path on success.
export async function writeProjectFile(params: {
  project: string;
  file?: string;
  mode?: ProjectWriteMode;
  note: string;
  summary?: string;
  triggers?: string[];
  always?: boolean;
  actorHandle: string;
}): Promise<{ ok: true; path: string; created: boolean; mode: ProjectWriteMode } | { error: string }> {
  const slug = slugifyProject(params.project);
  if (!slug) return { error: `project_note: "project" is not a usable name. Use a short slug like "neu-website".` };
  const mode: ProjectWriteMode = params.mode === "replace" ? "replace" : "append";
  const fileName = sanitizeProjectFileName(params.file, mode === "replace" ? "status.md" : "log.md");
  const { promises: fsp } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(projectsRoot(), slug);
  const abs = join(dir, fileName);

  return withLock(abs, async () => {
    let current: string | null = null;
    try {
      current = await fsp.readFile(abs, "utf8");
    } catch {
      current = null;
    }
    const res = applyProjectWrite(current, {
      mode,
      note: params.note,
      summary: params.summary,
      triggers: params.triggers,
      always: params.always,
      actorHandle: params.actorHandle,
      dateLabel: dateLabel(),
    });
    if ("error" in res) return res;
    try {
      await fsp.mkdir(dir, { recursive: true });
      // Compacted-out entries go to <project>/archive/<file> (append-only).
      // A subdirectory, so the index scan (files only) never picks it up and
      // the archive is never re-injected into prompts — still `cat`-able.
      if (res.archived && res.archived.length) {
        const archDir = join(dir, "archive");
        await fsp.mkdir(archDir, { recursive: true });
        await fsp.appendFile(join(archDir, fileName), res.archived.join("\n\n") + "\n\n", "utf8");
      }
      await fsp.writeFile(abs, res.content, "utf8");
    } catch (e) {
      return { error: `project_note: could not write the file (${(e as Error).message}).` };
    }
    // Refresh the human/shell-facing INDEX.md from disk (best-effort, awaited
    // so a shell `cat projects/INDEX.md` right after a write is current).
    await regenerateIndexFile().catch(() => {});
    return { ok: true, path: `projects/${slug}/${fileName}`, created: current == null, mode };
  });
}

// ─────────────────────────── read / index ───────────────────────────

// Scan the projects tree into a structured index. One read per file (to pull
// frontmatter) + stat for size/mtime. Fail-safe → [] on any error. INDEX.md
// itself is skipped (it's a derived artifact, not a tracked file).
export async function loadProjectIndex(): Promise<ProjectInfo[]> {
  try {
    const { promises: fsp } = await import("node:fs");
    const { join } = await import("node:path");
    const root = projectsRoot();
    const dirents = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    const projectDirs = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_PROJECTS);
    const out: ProjectInfo[] = [];
    for (const slug of projectDirs) {
      const dir = join(root, slug);
      const fents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const fileNames = fents
        .filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name) && e.name.toLowerCase() !== "index.md")
        .map((e) => e.name)
        .slice(0, MAX_FILES_PER_PROJECT);
      const files: ProjectFileInfo[] = [];
      for (const name of fileNames) {
        const path = join(dir, name);
        const st = await fsp.stat(path).catch(() => null);
        if (!st) continue;
        const raw = await fsp.readFile(path, "utf8").catch(() => "");
        const { meta, body } = parseProjectFile(raw);
        const snippet = bodyLead(body);
        files.push({ ...meta, name, path, size: st.size, mtimeMs: st.mtimeMs, snippet });
      }
      if (!files.length) continue;
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const owner = files.find((f) => f.name.toLowerCase() === "brief.md")?.owner || files[0]?.owner || "";
      out.push({ slug, owner, files });
    }
    return out;
  } catch {
    return [];
  }
}

function fmtSize(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}B`;
}
function fmtDate(mtimeMs: number): string {
  try {
    return new Date(mtimeMs).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

// Render the always-injected map of the whole projects tree. One line per file
// with its summary + provenance, so an agent knows what exists and who owns it
// WITHOUT loading every file. Capped.
export function renderProjectIndex(projects: ProjectInfo[], cap = INDEX_MAX_CHARS): string {
  if (!projects.length) return "";
  const lines: string[] = [];
  for (const p of projects) {
    lines.push(`◆ ${p.slug}${p.owner ? ` (owner @${p.owner})` : ""}`);
    for (const f of p.files) {
      const sum = f.summary ? ` — ${f.summary}` : "";
      const by = f.updatedBy ? ` @${f.updatedBy}` : "";
      const trig = f.triggers.length ? ` [triggers: ${f.triggers.join(", ")}]` : f.always ? " [always]" : "";
      lines.push(`   • ${f.name}${sum} · upd ${fmtDate(f.mtimeMs)}${by} · ${fmtSize(f.size)}${trig}`);
    }
  }
  let text = lines.join("\n");
  if (text.length > cap) text = text.slice(0, cap) + "\n…(index truncated)";
  return text;
}

// Pure: pick which files to inject for this run. A file matches when it's
// `always`, when any of its trigger keywords appears in the run text, when its
// project slug appears, or when its name (sans extension) appears. Freshest
// first. No fs — testable. Returns the file metas to read.
export function matchProjectFiles(projects: ProjectInfo[], triggerText: string): ProjectFileInfo[] {
  const hay = (triggerText || "").toLowerCase();
  const matched: ProjectFileInfo[] = [];
  for (const p of projects) {
    const slugHit = p.slug.length >= 3 && hay.includes(p.slug.toLowerCase());
    for (const f of p.files) {
      const base = f.name.replace(/\.(md|txt)$/i, "").toLowerCase();
      const hit =
        f.always ||
        slugHit ||
        (base.length >= 4 && hay.includes(base)) ||
        f.triggers.some((t) => t && hay.includes(t));
      if (hit) matched.push(f);
    }
  }
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matched;
}

// ─────────────────────────── semantic retrieval ───────────────────────────
// The keyword matcher above is precise and free but blind to paraphrase: a run
// about "outreach emails to dev-tool sites" won't surface a decisions.md whose
// summary is "guest-post & partnership targets". When an embeddings backend is
// configured (EMBEDDINGS_BASE_URL), we additionally rank the *un-keyword-matched*
// files by cosine similarity of their representative text to the run, and fold
// the best few in. It is purely additive (keyword matches keep budget priority)
// and a complete no-op when embeddings are off — so existing behaviour is intact.

// Floor + caps. The floor is read per-call so it's tunable via env without a
// restart. Calibrated 2026-06-19 against the live gemini-embedding-001 backend
// over the real project tree: relevant query/file pairs land 0.58–0.67, while
// cross-project / unrelated pairs top out at ~0.556 (an off-topic query maxed at
// 0.521). 0.6 clears that false-positive ceiling with margin and still catches
// the paraphrase wins keyword matching misses; a borderline miss stays visible
// in the always-injected index. Raise PROJECT_SEM_FLOOR for stricter, lower for
// more recall.
function semFloor(): number {
  const v = Number(process.env.PROJECT_SEM_FLOOR);
  return Number.isFinite(v) && process.env.PROJECT_SEM_FLOOR ? v : 0.6;
}
const SEM_TOP_N = 3; // most semantic additions per turn (budget still caps reads)
const SEM_MAX_CANDIDATES = 30; // bound embedding cost on a large tree
const SEM_QUERY_MAX = 2000; // chars of triggerText to embed
const SEM_REP_MAX = 500; // chars of a file's representative text to embed
const SEM_MIN_QUERY = 12; // skip tiny/empty queries — no useful signal

// Strip `## <date> · @handle` provenance headers, then take the lead of the body
// as the embed-able snippet (the curated `summary` is preferred when present).
function bodyLead(body: string): string {
  return (body || "")
    .replace(/^##\s.*$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, SEM_REP_MAX);
}

// What we embed for a file: its project + name + summary-or-snippet.
function representativeText(slug: string, f: ProjectFileInfo): string {
  const base = f.name.replace(/\.(md|txt)$/i, "");
  const gist = (f.summary || f.snippet || "").trim();
  return `${slug} / ${base}: ${gist}`.slice(0, SEM_REP_MAX);
}

// Process-local cache of file embeddings, keyed by path+mtime so a write (which
// bumps mtime) invalidates the entry. Steady state: only the query embeds.
const semEmbedCache = new Map<string, number[]>();
const SEM_CACHE_MAX = 500;
function cacheGet(key: string): number[] | undefined {
  return semEmbedCache.get(key);
}
function cacheSet(key: string, vec: number[]): void {
  if (semEmbedCache.size >= SEM_CACHE_MAX) semEmbedCache.clear();
  semEmbedCache.set(key, vec);
}
// Test-only: reset the cache between cases.
export function _clearSemCache(): void {
  semEmbedCache.clear();
}

// Pure: given the query vector and candidates (each with its vector, possibly
// null when embedding failed), return the files scoring ≥ floor, best-first,
// capped to topN. No fs / no network — unit-testable.
export function rankBySimilarity(
  queryVec: number[],
  candidates: Array<{ file: ProjectFileInfo; vec: number[] | null }>,
  floor: number,
  topN: number,
): ProjectFileInfo[] {
  return candidates
    .map((c) => ({ file: c.file, score: c.vec ? cosine(queryVec, c.vec) : -1 }))
    .filter((s) => s.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topN))
    .map((s) => s.file);
}

// Embedding-backed match over the files NOT already chosen by the keyword pass.
// One embed() call per turn: [query, ...uncached representative texts]. Fail-safe
// → [] (embeddings off, tiny query, no candidates, or any backend error).
export async function semanticMatchProjectFiles(
  projects: ProjectInfo[],
  triggerText: string,
  exclude: Set<string>,
): Promise<ProjectFileInfo[]> {
  if (!embeddingsEnabled()) return [];
  const q = (triggerText || "").trim().slice(0, SEM_QUERY_MAX);
  if (q.length < SEM_MIN_QUERY) return [];

  const cands: Array<{ slug: string; file: ProjectFileInfo }> = [];
  for (const p of projects) {
    for (const f of p.files) {
      if (exclude.has(f.path)) continue;
      cands.push({ slug: p.slug, file: f });
    }
  }
  if (!cands.length) return [];
  const capped = cands.slice(0, SEM_MAX_CANDIDATES);

  // Resolve each candidate's vector from cache; batch-embed the misses + query.
  const keyFor = (f: ProjectFileInfo) => `${f.path}|${f.mtimeMs}`;
  const vecs: Array<number[] | null> = capped.map((c) => cacheGet(keyFor(c.file)) ?? null);
  const misses = capped
    .map((c, i) => ({ i, c }))
    .filter((m) => vecs[m.i] == null);

  const batch = [q, ...misses.map((m) => representativeText(m.c.slug, m.c.file))];
  const embedded = await embed(batch);
  if (!embedded || !embedded[0]) return [];
  const queryVec = embedded[0];
  misses.forEach((m, j) => {
    const v = embedded[j + 1];
    if (v && v.length) {
      cacheSet(keyFor(m.c.file), v);
      vecs[m.i] = v;
    }
  });

  return rankBySimilarity(
    queryVec,
    capped.map((c, i) => ({ file: c.file, vec: vecs[i] })),
    semFloor(),
    SEM_TOP_N,
  );
}

// What to inject from a file body under a char cap. A plain document takes its
// lead. An append LOG is newest-at-the-bottom, so a head slice would inject the
// OLDEST entries and never the current status (the live bug: status.md was
// 20 KB, the 1600-char lead never moved). Keep the head (brief text) plus as
// many of the NEWEST entries as fit, and say how many were omitted.
export function excerptForInjection(body: string, max: number): string {
  const text = (body || "").trim();
  if (text.length <= max) return text;
  const { head, entries } = splitEntries(text);
  if (!entries.length) return text.slice(0, max);
  const headPart = head.length > Math.floor(max * 0.4) ? head.slice(0, Math.floor(max * 0.4)).trimEnd() + " …" : head;
  const picked: string[] = [];
  let used = headPart.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const cost = e.length + 2;
    if (picked.length && used + cost > max - 80) break;
    if (!picked.length && used + cost > max - 80) {
      // Even the newest entry doesn't fit — take its head so the latest state still shows.
      picked.unshift(e.slice(0, Math.max(0, max - 80 - used)).trimEnd() + " …");
      used = max;
      break;
    }
    picked.unshift(e);
    used += cost;
  }
  const omitted = entries.length - picked.length;
  const marker = omitted > 0 ? `…(${omitted} older entr${omitted === 1 ? "y" : "ies"} omitted — cat the file for the full log)` : "";
  return [headPart, marker, ...picked].filter(Boolean).join("\n\n");
}

// Read the bodies of the matched files within the injection budget.
async function readProjectFileBodies(
  matched: ProjectFileInfo[],
): Promise<Array<{ project: string; name: string; content: string }>> {
  const { promises: fsp } = await import("node:fs");
  const { basename, dirname } = await import("node:path");
  const out: Array<{ project: string; name: string; content: string }> = [];
  let total = 0;
  for (const f of matched) {
    if (out.length >= FILES_MAX_COUNT) break;
    const raw = await fsp.readFile(f.path, "utf8").catch(() => "");
    if (!raw.trim()) continue;
    const { body } = parseProjectFile(raw);
    if (!body) continue;
    const content = excerptForInjection(body, FILE_INJECT_MAX_CHARS);
    if (total + content.length > FILES_TOTAL_MAX_CHARS) break;
    total += content.length;
    out.push({ project: basename(dirname(f.path)), name: f.name, content });
  }
  return out;
}

// Build the per-turn project context for the prompt: the always-injected index
// plus the trigger-matched file bodies, both budget-bounded. Fail-safe.
export async function buildProjectContext(
  triggerText: string,
): Promise<{ index: string; files: Array<{ project: string; name: string; content: string }> }> {
  try {
    const projects = await loadProjectIndex();
    if (!projects.length) return { index: "", files: [] };
    const index = renderProjectIndex(projects);
    // Keyword matches first (precise, free, keep budget priority); then fold in
    // semantically-relevant files the keyword pass missed (no-op if embeddings
    // are off or the call fails). Dedupe by path, keyword order preserved.
    const keyword = matchProjectFiles(projects, triggerText);
    const chosen = new Set(keyword.map((f) => f.path));
    const semantic = await semanticMatchProjectFiles(projects, triggerText, chosen).catch(() => []);
    const files = await readProjectFileBodies([...keyword, ...semantic]);
    return { index, files };
  } catch {
    return { index: "", files: [] };
  }
}

// Write a plain INDEX.md to <mount>/projects so an agent browsing the mount by
// shell sees the same map the prompt injects. Best-effort; last-writer-wins is
// fine for a derived artifact.
export async function regenerateIndexFile(): Promise<void> {
  const projects = await loadProjectIndex();
  const { promises: fsp } = await import("node:fs");
  const { join } = await import("node:path");
  const body = [
    "# Project tracker",
    "",
    "Shared, multi-file project memory under `/workspace/projects/`. Every agent",
    "reads and writes these via the `project_note` action. Append is the default;",
    "a full rewrite is owner-gated. This INDEX.md is auto-generated — do not edit.",
    "",
    renderProjectIndex(projects, 100000) || "(no projects tracked yet)",
    "",
  ].join("\n");
  await fsp.mkdir(projectsRoot(), { recursive: true }).catch(() => {});
  await fsp.writeFile(join(projectsRoot(), "INDEX.md"), body, "utf8");
}
