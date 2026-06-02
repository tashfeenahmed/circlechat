import { and, eq, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { knowledgeChunks } from "../db/schema.js";
import { id } from "./ids.js";
import { embed, embedOne, cosine, embeddingsEnabled } from "./embeddings.js";

export type KnowledgeSource = "artifact" | "message" | "task" | "note";

// Ingest a piece of text into the per-workspace knowledge store. Best-effort
// and fire-and-forget by callers: no-op if embeddings aren't configured or the
// text is empty, swallows all errors so ingestion can never break a user/agent
// action. Upserts on (workspace, source, sourceId) so re-ingesting updates.
export async function ingestKnowledge(params: {
  workspaceId: string;
  source: KnowledgeSource;
  sourceId: string;
  title?: string;
  text: string;
}): Promise<void> {
  if (!embeddingsEnabled()) return;
  const text = (params.text || "").trim();
  if (!text) return;
  try {
    const vector = await embedOne(text.slice(0, 8000));
    if (!vector) return;
    const row = {
      id: id("kn"),
      workspaceId: params.workspaceId,
      source: params.source,
      sourceId: params.sourceId || "",
      title: (params.title || "").slice(0, 300),
      text: text.slice(0, 8000),
      embedding: vector,
      dim: vector.length,
      createdAt: new Date(),
    };
    await db
      .insert(knowledgeChunks)
      .values(row)
      .onConflictDoUpdate({
        target: [knowledgeChunks.workspaceId, knowledgeChunks.source, knowledgeChunks.sourceId],
        set: { title: row.title, text: row.text, embedding: row.embedding, dim: row.dim, createdAt: row.createdAt },
      });
  } catch {
    /* ingestion is best-effort */
  }
}

export interface RecallHit {
  source: KnowledgeSource;
  sourceId: string;
  title: string;
  text: string;
  score: number;
}

// Semantic search over a workspace's knowledge. Embeds the query, scores every
// chunk by cosine similarity in-app (fine at MVP scale), returns the top-k above
// a floor. Empty array if embeddings aren't configured or nothing clears the bar.
export async function recallKnowledge(
  workspaceId: string,
  query: string,
  k = 5,
): Promise<RecallHit[]> {
  if (!embeddingsEnabled() || !query.trim()) return [];
  const qv = await embedOne(query.trim());
  if (!qv) return [];
  const rows = await db
    .select()
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.workspaceId, workspaceId));
  const scored = rows
    .map((r) => ({
      source: r.source as KnowledgeSource,
      sourceId: r.sourceId,
      title: r.title,
      text: r.text,
      score: cosine(qv, r.embedding as number[]),
    }))
    .filter((h) => h.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(k, 20)));
  return scored;
}

// Convenience: remove a workspace's chunks for a deleted source (best-effort).
// Not gated on embeddingsEnabled — deletion must run even if embeddings were
// later turned off, so stale chunks don't linger.
export async function forgetKnowledge(workspaceId: string, source: KnowledgeSource, sourceId: string): Promise<void> {
  try {
    await db
      .delete(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.workspaceId, workspaceId),
          eq(knowledgeChunks.source, source),
          eq(knowledgeChunks.sourceId, sourceId),
        ),
      );
  } catch {
    /* best-effort */
  }
}

// Drop all artifact-derived chunks for a task (sourceId is `${taskId}:${name}`).
// Called when a task is deleted so its knowledge doesn't outlive it.
export async function forgetTaskKnowledge(workspaceId: string, taskId: string): Promise<void> {
  try {
    await db
      .delete(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.workspaceId, workspaceId),
          eq(knowledgeChunks.source, "artifact"),
          like(knowledgeChunks.sourceId, `${taskId}:%`),
        ),
      );
  } catch {
    /* best-effort */
  }
}

// re-export so callers can gate UI/log lines
export { embeddingsEnabled, embed };
