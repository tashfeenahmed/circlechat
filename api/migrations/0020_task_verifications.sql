CREATE TABLE IF NOT EXISTS "task_verifications" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"task_id" varchar(32) NOT NULL,
	"workspace_id" varchar(32) NOT NULL,
	"task_type" varchar(16) DEFAULT 'general' NOT NULL,
	"method" varchar(16) NOT NULL,
	"verdict" varchar(12) NOT NULL,
	"score" real,
	"rubric_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"artifact_id" varchar(32),
	"decided_by" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_verifications_task_idx" ON "task_verifications" ("task_id","created_at");
