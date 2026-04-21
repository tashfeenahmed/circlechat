-- 0006_tasks_workspace — tasks become workspace-scoped. Boards are a single
-- per-workspace board (not per-channel). conversation_id stays as an optional
-- pointer to the channel a task was spawned from (for context), but is no
-- longer the primary scope.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "workspace_id" varchar(32);
--> statement-breakpoint
UPDATE "tasks" SET "workspace_id" = (
  SELECT "workspace_id" FROM "conversations" WHERE "conversations"."id" = "tasks"."conversation_id"
) WHERE "workspace_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "conversation_id" DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_ws_idx" ON "tasks" ("workspace_id", "archived");
