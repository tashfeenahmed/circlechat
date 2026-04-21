-- 0005_tasks — channel-scoped kanban boards. Every channel has a board
-- (no extra row to create); tasks reference conversations directly.

CREATE TABLE IF NOT EXISTS "tasks" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "conversation_id" varchar(32) NOT NULL,
  "parent_id" varchar(32),
  "title" varchar(200) NOT NULL,
  "body_md" text NOT NULL DEFAULT '',
  "status" varchar(20) NOT NULL DEFAULT 'backlog',
  "position" real NOT NULL DEFAULT 0,
  "due_at" timestamp with time zone,
  "progress" integer NOT NULL DEFAULT 0,
  "created_by" varchar(32) NOT NULL,
  "source_message_id" varchar(32),
  "archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_conv_idx" ON "tasks" ("conversation_id", "archived");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_parent_idx" ON "tasks" ("parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_status_pos_idx" ON "tasks" ("conversation_id", "status", "position");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_assignees" (
  "task_id" varchar(32) NOT NULL,
  "member_id" varchar(32) NOT NULL,
  "assigned_by" varchar(32) NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("task_id", "member_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_assignees_member_idx" ON "task_assignees" ("member_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_labels" (
  "task_id" varchar(32) NOT NULL,
  "label" varchar(40) NOT NULL,
  PRIMARY KEY ("task_id", "label")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_links" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "task_id" varchar(32) NOT NULL,
  "linked_task_id" varchar(32) NOT NULL,
  "kind" varchar(20) NOT NULL DEFAULT 'relates',
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_links_unique" ON "task_links" ("task_id", "linked_task_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_links_linked_idx" ON "task_links" ("linked_task_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_comments" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "task_id" varchar(32) NOT NULL,
  "member_id" varchar(32) NOT NULL,
  "body_md" text NOT NULL,
  "mentions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "edited_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_task_ts_idx" ON "task_comments" ("task_id", "ts");
--> statement-breakpoint

-- Activity: status changes, assignment changes, etc. Small denormalised log so
-- the card detail can render "09:55 · moved to review · by @mina".
CREATE TABLE IF NOT EXISTS "task_activity" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "task_id" varchar(32) NOT NULL,
  "actor_member_id" varchar(32) NOT NULL,
  "kind" varchar(30) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_activity_task_ts_idx" ON "task_activity" ("task_id", "ts");
