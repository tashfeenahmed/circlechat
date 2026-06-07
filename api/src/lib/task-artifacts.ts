import { and, eq, desc, isNull, sql as dsql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { taskArtifacts, tasks, members, users, agents, type TaskArtifact } from "../db/schema.js";
import { putObject, publicUrl, readObject, removeStoragePrefix } from "./storage.js";
import { id as makeId } from "./ids.js";
import type { Attachment } from "../db/schema.js";
import { ingestKnowledge } from "./knowledge.js";
import { recordProgress } from "./ledger-core.js";

// Hard limits — mirror the agent attachment ingest (executor.ts) so artifacts
// can't be used to smuggle in larger payloads than the share path allows.
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_ARTIFACTS_PER_TASK = 500;

// Is this content type plain text we can usefully embed for RAG? (markdown,
// text, json, csv, code, etc.) Binary deliverables are skipped.
export function isTextualContentType(ct: string): boolean {
  const t = (ct || "").toLowerCase();
  return (
    t.startsWith("text/") ||
    t.includes("markdown") ||
    t.includes("json") ||
    t.includes("csv") ||
    t.includes("xml") ||
    t.includes("yaml") ||
    t.includes("javascript") ||
    t === "application/octet-stream" // inline text artifacts default to this
  );
}

// Substance gate (PR E, heuristic v1) — used by done-requires-evidence to
// reject placeholder/title-only "deliverables" (the junk-file bypass). Cheap
// and instant; a determined agent could pad past it, but the human-sign-off
// override covers that and an LLM judge can layer on later.
// Floor sized to kill the observed stubs (the 26–34 byte title-echoes) with
// margin, without false-positiving a legit-but-terse deliverable (e.g. a short
// list of links is ~150B). Padding past the floor is caught by the title-echo
// + low-distinct-word checks below; semantic relevance is the LLM judge's job.
export const MIN_SUBSTANTIVE_BYTES = 120; // below this is a stub, not a deliverable
const TRUST_SIZE_BYTES = 2048;            // above this, trust size; don't read bytes
const MIN_SUBSTANTIVE_TEXT_CHARS = 90;    // borderline text must carry real content

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// One current artifact as the API/UI sees it: the Attachment descriptor (so it
// drops straight into the existing <Attachments> component / FileViewer) plus
// the versioning + attribution metadata that makes it a first-class deliverable.
export interface ArtifactView extends Attachment {
  id: string;
  version: number;
  sha256: string | null;
  createdBy: string;
  createdByHandle: string | null;
  createdByName: string | null;
  createdAt: string;
}

function sanitizeName(raw: string): string {
  const cleaned = (raw || "").trim().replace(/[^a-z0-9._-]/gi, "_").slice(0, 120);
  return cleaned || "file";
}

function toAttachment(row: TaskArtifact): Attachment {
  return {
    key: row.storageKey,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    url: publicUrl(row.storageKey),
  };
}

// Create (or version up) an artifact on a task. Writes the bytes to the object
// store under t/<taskId>/<artifactId>/<safeName>, then inserts a row at
// version = max(existing for this name) + 1. Callers must have already verified
// the task is in `workspaceId` and the principal may write to it.
export async function createArtifact(opts: {
  taskId: string;
  workspaceId: string;
  name: string;
  buffer: Buffer;
  contentType?: string;
  createdBy: string; // member id
}): Promise<ArtifactView> {
  const name = sanitizeName(opts.name);
  const artifactId = makeId("art");
  const safeName = name; // already sanitized
  const storageKey = `t/${opts.taskId}/${artifactId}/${safeName}`;
  const sha256 = createHash("sha256").update(opts.buffer).digest("hex");

  // Next version for this (task, name). The unique index on
  // (task_id, name, version) is the backstop against a racing duplicate.
  const [maxRow] = await db
    .select({ m: dsql<number>`coalesce(max(${taskArtifacts.version}), 0)`.as("m") })
    .from(taskArtifacts)
    .where(and(eq(taskArtifacts.taskId, opts.taskId), eq(taskArtifacts.name, name)));
  const version = (Number(maxRow?.m) || 0) + 1;

  await putObject(storageKey, opts.buffer);
  const row = {
    id: artifactId,
    taskId: opts.taskId,
    workspaceId: opts.workspaceId,
    name,
    version,
    storageKey,
    contentType: (opts.contentType || "").split(";")[0].trim() || "application/octet-stream",
    size: opts.buffer.length,
    sha256,
    createdBy: opts.createdBy,
  };
  await db.insert(taskArtifacts).values(row);

  // Shipping a deliverable is the strongest forward-motion signal — reset the
  // goal's stall counter so the detector never misreads an actively-delivering
  // goal as stalled. Best-effort, fire-and-forget.
  void db
    .select({ goalId: tasks.goalId })
    .from(tasks)
    .where(eq(tasks.id, opts.taskId))
    .limit(1)
    .then(([t]) => (t?.goalId ? recordProgress(t.goalId) : undefined))
    .catch(() => {});

  // RAG: ingest textual deliverables into the per-workspace knowledge store so
  // agents can recall them across runs. Best-effort, fire-and-forget, no-op
  // unless embeddings are configured.
  if (isTextualContentType(row.contentType)) {
    void ingestKnowledge({
      workspaceId: opts.workspaceId,
      source: "artifact",
      sourceId: `${opts.taskId}:${name}`,
      title: name,
      text: opts.buffer.toString("utf8"),
    });
  }

  const handle = await resolveMember(opts.createdBy);
  return {
    ...toAttachment(row as TaskArtifact),
    id: artifactId,
    version,
    sha256,
    createdBy: opts.createdBy,
    createdByHandle: handle?.handle ?? null,
    createdByName: handle?.name ?? null,
    createdAt: new Date().toISOString(),
  };
}

// The current set of artifacts on a task — for each distinct name, the highest
// non-deleted version. This is what the board card / agent list call shows.
export async function currentArtifacts(taskId: string): Promise<ArtifactView[]> {
  const rows = await db
    .select()
    .from(taskArtifacts)
    .where(and(eq(taskArtifacts.taskId, taskId), isNull(taskArtifacts.deletedAt)))
    .orderBy(desc(taskArtifacts.version));
  // Keep the first (highest version) row per name.
  const byName = new Map<string, TaskArtifact>();
  for (const r of rows) if (!byName.has(r.name)) byName.set(r.name, r);
  const current = Array.from(byName.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const dir = await resolveMembers(current.map((r) => r.createdBy));
  return current.map((r) => ({
    ...toAttachment(r),
    id: r.id,
    version: r.version,
    sha256: r.sha256,
    createdBy: r.createdBy,
    createdByHandle: dir.get(r.createdBy)?.handle ?? null,
    createdByName: dir.get(r.createdBy)?.name ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

// Latest non-deleted version of one named artifact on a task.
export async function currentArtifactByName(
  taskId: string,
  name: string,
): Promise<TaskArtifact | null> {
  const [row] = await db
    .select()
    .from(taskArtifacts)
    .where(
      and(
        eq(taskArtifacts.taskId, taskId),
        eq(taskArtifacts.name, name),
        isNull(taskArtifacts.deletedAt),
      ),
    )
    .orderBy(desc(taskArtifacts.version))
    .limit(1);
  return row ?? null;
}

// Resolve an object-store key back to its artifact row — used by /files/* auth
// to authorize a `t/<task_id>/…` key against the task it belongs to. Only
// non-deleted artifacts resolve (a soft-deleted artifact's blob stops serving).
export async function artifactByStorageKey(key: string): Promise<TaskArtifact | null> {
  const [row] = await db
    .select()
    .from(taskArtifacts)
    .where(and(eq(taskArtifacts.storageKey, key), isNull(taskArtifacts.deletedAt)))
    .limit(1);
  return row ?? null;
}

// All live (non-deleted) artifact rows on a task — every version, not deduped
// by name. Used by the done-evidence gate, which only needs to find ONE
// substantive deliverable.
export async function liveArtifactRows(taskId: string): Promise<TaskArtifact[]> {
  return db
    .select()
    .from(taskArtifacts)
    .where(and(eq(taskArtifacts.taskId, taskId), isNull(taskArtifacts.deletedAt)));
}

// Heuristic substance check, working on raw bytes so it runs both at SUBMIT
// time (before a row exists — reject stubs at the source) and at the done-gate.
// Tiered to bound I/O:
//   • size < MIN          → a stub, reject (kills the 26-byte title files)
//   • size ≥ TRUST_SIZE   → trust it (real work is big)
//   • binary in between   → accept (image/pdf/zip ≥120B is plausibly real)
//   • text in between     → reject title-echoes and repetitive padding
export function isSubstantiveContent(
  buffer: Buffer,
  contentType: string,
  name: string,
  taskTitle: string,
): boolean {
  if (buffer.length < MIN_SUBSTANTIVE_BYTES) return false;
  if (buffer.length >= TRUST_SIZE_BYTES) return true;

  const ct = (contentType || "").toLowerCase();
  const isText =
    /^text\/|json|xml|csv|markdown|javascript|typescript|x-sh|yaml|html/.test(ct) ||
    /\.(md|txt|csv|json|ya?ml|js|ts|tsx|py|sh|html?|sql)$/i.test(name);
  if (!isText) return true; // binary blob over the floor — assume a real file

  const content = normalizeText(buffer.toString("utf8"));
  if (content.length < MIN_SUBSTANTIVE_TEXT_CHARS) return false;
  const title = normalizeText(taskTitle || "");
  // Reject content that is essentially just the task title restated.
  if (title && (content === title || (content.includes(title) && content.length < title.length + 60)))
    return false;
  // Reject long-but-repetitive content — the obvious dodge once the size floor
  // bites is to paste the title (or a phrase) N times. Few distinct words
  // across many total words = padding, not a deliverable.
  const words = content.split(" ").filter(Boolean);
  if (words.length >= 12 && new Set(words).size < 8) return false;
  return true;
}

// Done-gate variant: same check against a stored row, reading the blob only for
// the borderline-size text case.
export async function isSubstantiveArtifact(
  row: TaskArtifact,
  taskTitle: string,
): Promise<boolean> {
  if (row.size < MIN_SUBSTANTIVE_BYTES) return false;
  if (row.size >= TRUST_SIZE_BYTES) return true;
  const buf = await readObject(row.storageKey);
  if (!buf) return false;
  return isSubstantiveContent(buf, row.contentType, row.name, taskTitle);
}

export async function loadArtifact(artifactId: string): Promise<TaskArtifact | null> {
  const [row] = await db.select().from(taskArtifacts).where(eq(taskArtifacts.id, artifactId)).limit(1);
  return row ?? null;
}

// Soft-delete one artifact version. Authorization (author-or-admin) is the
// caller's job — this just stamps deleted_at. Blob is left in storage (other
// versions / audit); it simply stops being served once the row is gone (the
// /files auth re-checks the live row).
export async function softDeleteArtifact(artifactId: string): Promise<void> {
  await db
    .update(taskArtifacts)
    .set({ deletedAt: new Date() })
    .where(eq(taskArtifacts.id, artifactId));
}

// Hard-delete every artifact row for these tasks AND unlink their blobs.
// Called when a task is hard-deleted (deleteTask) — without it the rows + the
// t/<task>/… objects on disk are orphaned. Includes soft-deleted rows since the
// whole task is going away. deleteObject is idempotent, so missing blobs are fine.
export async function purgeArtifactsForTasks(taskIds: string[]): Promise<void> {
  if (!taskIds.length) return;
  const { inArray } = await import("drizzle-orm");
  await db.delete(taskArtifacts).where(inArray(taskArtifacts.taskId, taskIds));
  // Every artifact blob for a task lives under t/<taskId>/…, so dropping that
  // subtree clears the bytes AND the now-empty dirs in one shot.
  for (const id of taskIds) await removeStoragePrefix(`t/${id}`);
}

export async function artifactCount(taskId: string): Promise<number> {
  const [r] = await db
    .select({ c: dsql<number>`count(*)::int`.as("c") })
    .from(taskArtifacts)
    .where(and(eq(taskArtifacts.taskId, taskId), isNull(taskArtifacts.deletedAt)));
  return Number(r?.c) || 0;
}

async function resolveMember(
  memberId: string,
): Promise<{ handle: string; name: string } | null> {
  return (await resolveMembers([memberId])).get(memberId) ?? null;
}

// memberId → {handle,name} (user OR agent). Mirrors the resolver pattern used
// across the routes, kept local so the artifact lib is self-contained.
async function resolveMembers(
  memberIds: string[],
): Promise<Map<string, { handle: string; name: string }>> {
  const out = new Map<string, { handle: string; name: string }>();
  const dedup = Array.from(new Set(memberIds.filter(Boolean)));
  if (!dedup.length) return out;
  const { inArray } = await import("drizzle-orm");
  const mrows = await db.select().from(members).where(inArray(members.id, dedup));
  const userRefs = mrows.filter((m) => m.kind === "user").map((m) => m.refId);
  const agentRefs = mrows.filter((m) => m.kind === "agent").map((m) => m.refId);
  const uRows = userRefs.length ? await db.select().from(users).where(inArray(users.id, userRefs)) : [];
  const aRows = agentRefs.length ? await db.select().from(agents).where(inArray(agents.id, agentRefs)) : [];
  const uMap = new Map(uRows.map((u) => [u.id, u]));
  const aMap = new Map(aRows.map((a) => [a.id, a]));
  for (const m of mrows) {
    const ref = m.kind === "user" ? uMap.get(m.refId) : aMap.get(m.refId);
    if (ref) out.set(m.id, { handle: ref.handle, name: ref.name });
  }
  return out;
}
