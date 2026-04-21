CREATE TABLE IF NOT EXISTS "users" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "email" varchar(255) NOT NULL,
  "name" varchar(100) NOT NULL,
  "handle" varchar(40) NOT NULL,
  "avatar_color" varchar(20) NOT NULL DEFAULT 'slate',
  "password_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_handle_key" ON "users" ("handle");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agents" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "handle" varchar(40) NOT NULL,
  "name" varchar(100) NOT NULL,
  "avatar_color" varchar(20) NOT NULL DEFAULT 'accent',
  "kind" varchar(20) NOT NULL,
  "adapter" varchar(20) NOT NULL,
  "config_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "model" varchar(80) NOT NULL DEFAULT '',
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" varchar(20) NOT NULL DEFAULT 'provisioning',
  "brief" text NOT NULL DEFAULT '',
  "heartbeat_interval_sec" integer NOT NULL DEFAULT 30,
  "bot_token" varchar(80) NOT NULL,
  "callback_url" text,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_handle_key" ON "agents" ("handle");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_token_key" ON "agents" ("bot_token");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "members" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "kind" varchar(10) NOT NULL,
  "ref_id" varchar(32) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "members_kind_ref_key" ON "members" ("kind", "ref_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversations" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "kind" varchar(10) NOT NULL,
  "name" varchar(100),
  "topic" text NOT NULL DEFAULT '',
  "is_private" boolean NOT NULL DEFAULT false,
  "archived" boolean NOT NULL DEFAULT false,
  "created_by" varchar(32),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversation_members" (
  "conversation_id" varchar(32) NOT NULL,
  "member_id" varchar(32) NOT NULL,
  "role" varchar(20) NOT NULL DEFAULT 'member',
  "last_read_at" timestamp with time zone,
  "muted" boolean NOT NULL DEFAULT false,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT conversation_members_pk PRIMARY KEY ("conversation_id", "member_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_members_member_idx" ON "conversation_members" ("member_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "messages" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "conversation_id" varchar(32) NOT NULL,
  "member_id" varchar(32) NOT NULL,
  "parent_id" varchar(32),
  "body_md" text NOT NULL,
  "attachments_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "mentions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "edited_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conv_ts_idx" ON "messages" ("conversation_id", "ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_parent_idx" ON "messages" ("parent_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reactions" (
  "message_id" varchar(32) NOT NULL,
  "member_id" varchar(32) NOT NULL,
  "emoji" varchar(32) NOT NULL,
  CONSTRAINT reactions_pk PRIMARY KEY ("message_id", "member_id", "emoji")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "agent_id" varchar(32) NOT NULL,
  "trigger" varchar(30) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'queued',
  "context_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "trace_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "conversation_id" varchar(32),
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "cost_usd" real,
  "error_text" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_agent_started_idx" ON "agent_runs" ("agent_id", "started_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "approvals" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "agent_run_id" varchar(32) NOT NULL,
  "agent_id" varchar(32) NOT NULL,
  "conversation_id" varchar(32),
  "scope" varchar(60) NOT NULL,
  "action" text NOT NULL,
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "decided_by" varchar(32),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "user_id" varchar(32) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "invites" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "email" varchar(255) NOT NULL,
  "token" varchar(64) NOT NULL,
  "invited_by" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invites_token_key" ON "invites" ("token");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_kv" (
  "agent_id" varchar(32) NOT NULL,
  "key" varchar(100) NOT NULL,
  "value_json" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT memory_kv_pk PRIMARY KEY ("agent_id", "key")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "presence" (
  "member_id" varchar(32) PRIMARY KEY NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'offline',
  "last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
