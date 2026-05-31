-- Per-member notification inbox. Backs the notification center: each row is
-- one thing a user should be told about (mention, DM, task assignment,
-- approval decision). Written alongside the existing event/trigger fan-out,
-- read by the /notifications routes. readAt null = unread.

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "workspace_id" varchar(32) NOT NULL,
  "member_id" varchar(32) NOT NULL,
  "kind" varchar(30) NOT NULL,
  "actor_member_id" varchar(32),
  "title" varchar(200) NOT NULL DEFAULT '',
  "body" text NOT NULL DEFAULT '',
  "link" text NOT NULL DEFAULT '',
  "conversation_id" varchar(32),
  "message_id" varchar(32),
  "task_id" varchar(32),
  "read_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notifications_member_created_idx"
  ON "notifications" ("member_id", "created_at");
CREATE INDEX IF NOT EXISTS "notifications_member_unread_idx"
  ON "notifications" ("member_id", "read_at");
