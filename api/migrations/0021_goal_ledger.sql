CREATE TABLE IF NOT EXISTS "goal_ledgers" (
	"goal_id" varchar(32) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(32) NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"guesses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan" text DEFAULT '' NOT NULL,
	"progress_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tried_dead_ends" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stall_count" integer DEFAULT 0 NOT NULL,
	"last_progress_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replan_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_ledgers_ws_idx" ON "goal_ledgers" ("workspace_id");
