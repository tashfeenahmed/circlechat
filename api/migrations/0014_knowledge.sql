-- Per-workspace knowledge store for cross-run RAG. Each row is a chunk of text
-- (a task deliverable, a message, a note) with its embedding vector stored as a
-- JSON number[] — no pgvector extension required; cosine similarity is computed
-- in the app, which is fine at MVP scale. Unique on (workspace, source,
-- source_id) so re-ingesting the same source updates in place. Idempotent.
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "source" varchar(20) NOT NULL,
  "source_id" varchar(64) NOT NULL DEFAULT '',
  "title" varchar(300) NOT NULL DEFAULT '',
  "text" text NOT NULL,
  "embedding" jsonb NOT NULL,
  "dim" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_ws_idx" ON "knowledge_chunks" ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_src_uniq" ON "knowledge_chunks" ("workspace_id", "source", "source_id");
