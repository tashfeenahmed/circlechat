-- Goals: the delegation spine. A goal is a unit of intent the planner
-- decomposes into a dependency graph of tasks. Goals nest (parent_goal_id) so
-- mission → project → goal mirrors a company tree, and every task can trace
-- back to a goal via tasks.goal_id. Agents grow a `capabilities` tag list so
-- the planner can route each decomposed subtask to the right agent. Idempotent.
CREATE TABLE IF NOT EXISTS "goals" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "parent_goal_id" varchar(32),
  "title" varchar(300) NOT NULL,
  "body_md" text NOT NULL DEFAULT '',
  "status" varchar(20) NOT NULL DEFAULT 'open',
  "owner_member_id" varchar(32),
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_ws_idx" ON "goals" ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_parent_idx" ON "goals" ("parent_goal_id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "goal_id" varchar(32);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_goal_idx" ON "tasks" ("goal_id");
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb;
