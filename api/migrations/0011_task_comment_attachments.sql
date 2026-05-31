-- schema.ts declares task_comments.attachments_json and task_comments.parent_id
-- (and getTaskDetail/listTaskComments select both), but no migration ever
-- created them — 0005_tasks created task_comments without them. Result: every
-- GET /api/tasks/:id 500s with `column "attachments_json" does not exist`.
-- Add the missing columns to match the schema. Idempotent (IF NOT EXISTS) so it
-- is safe on databases where they were hand-added as a hotfix.
ALTER TABLE "task_comments" ADD COLUMN IF NOT EXISTS "attachments_json" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN IF NOT EXISTS "parent_id" varchar(32);
