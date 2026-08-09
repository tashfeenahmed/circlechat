-- P1 product platform: inspectable decision memory, governed app delivery,
-- provider-backed PR rooms, executable board stages, reusable blueprints,
-- steerable runs, and enterprise access/audit controls.

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "retention_days" integer;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "data_residency" varchar(32) NOT NULL DEFAULT 'operator';
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "role" varchar(40) NOT NULL DEFAULT 'member';
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "channel_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamptz;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "cancelled_by" varchar(32);
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "steer_json" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "followup_json" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "timeout_at" timestamptz;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "owner_member_id" varchar(32);

ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamptz;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "cancelled_by" varchar(32);
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "steer_json" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "followup_json" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "timeout_at" timestamptz;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "owner_member_id" varchar(32);

CREATE TABLE IF NOT EXISTS "decision_memories" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "kind" varchar(20) NOT NULL,
  "title" varchar(180) NOT NULL,
  "decision" text NOT NULL,
  "rationale" text NOT NULL DEFAULT '',
  "alternatives_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "provenance_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "source" varchar(20) NOT NULL DEFAULT 'observer',
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "supersedes_id" varchar(32),
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "corrected_at" timestamptz,
  CONSTRAINT "decision_memories_kind_check" CHECK ("kind" IN ('decision','precedent','policy','exception','steer')),
  CONSTRAINT "decision_memories_status_check" CHECK ("status" IN ('active','corrected','superseded'))
);
CREATE INDEX IF NOT EXISTS "decision_memories_ws_idx" ON "decision_memories" ("workspace_id", "status", "created_at");

CREATE TABLE IF NOT EXISTS "hosted_apps" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "task_id" varchar(32) NOT NULL,
  "name" varchar(140) NOT NULL,
  "slug" varchar(80) NOT NULL,
  "preview_token" varchar(80) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'preview',
  "active_deployment_id" varchar(32),
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "hosted_apps_status_check" CHECK ("status" IN ('preview','pending','published','disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "hosted_apps_slug_key" ON "hosted_apps" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "hosted_apps_preview_key" ON "hosted_apps" ("preview_token");
CREATE INDEX IF NOT EXISTS "hosted_apps_ws_idx" ON "hosted_apps" ("workspace_id", "status");

CREATE TABLE IF NOT EXISTS "app_deployments" (
  "id" varchar(32) PRIMARY KEY,
  "app_id" varchar(32) NOT NULL,
  "artifact_id" varchar(32) NOT NULL,
  "artifact_sha256" varchar(64),
  "status" varchar(20) NOT NULL DEFAULT 'preview',
  "health_status" varchar(20) NOT NULL DEFAULT 'healthy',
  "requested_by" varchar(32) NOT NULL,
  "reviewed_by" varchar(32),
  "review_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  CONSTRAINT "app_deployments_status_check" CHECK ("status" IN ('preview','pending','published','rejected','retired'))
);
CREATE INDEX IF NOT EXISTS "app_deployments_app_idx" ON "app_deployments" ("app_id", "created_at");

CREATE TABLE IF NOT EXISTS "app_logs" (
  "id" varchar(32) PRIMARY KEY,
  "app_id" varchar(32) NOT NULL,
  "deployment_id" varchar(32),
  "level" varchar(12) NOT NULL DEFAULT 'info',
  "event" varchar(80) NOT NULL,
  "message" text NOT NULL DEFAULT '',
  "meta_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "app_logs_app_idx" ON "app_logs" ("app_id", "created_at");

CREATE TABLE IF NOT EXISTS "pr_rooms" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "conversation_id" varchar(32) NOT NULL,
  "connector_id" varchar(32),
  "provider" varchar(20) NOT NULL,
  "repository" varchar(240) NOT NULL,
  "pr_number" integer NOT NULL,
  "title" varchar(240) NOT NULL DEFAULT '',
  "url" text NOT NULL DEFAULT '',
  "state" varchar(20) NOT NULL DEFAULT 'open',
  "head_ref" varchar(160) NOT NULL DEFAULT '',
  "base_ref" varchar(160) NOT NULL DEFAULT '',
  "diff_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "checks_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reviews_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "protection_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_synced_at" timestamptz,
  "last_error" text,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pr_rooms_provider_check" CHECK ("provider" IN ('github','gitlab'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "pr_rooms_unique" ON "pr_rooms" ("workspace_id", "provider", "repository", "pr_number");
CREATE INDEX IF NOT EXISTS "pr_rooms_conv_idx" ON "pr_rooms" ("conversation_id");

CREATE TABLE IF NOT EXISTS "board_stages" (
  "workspace_id" varchar(32) NOT NULL,
  "stage" varchar(20) NOT NULL,
  "title" varchar(80) NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "instructions" text NOT NULL DEFAULT '',
  "entry_rules_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "exit_rules_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "agent_id" varchar(32),
  "skill" varchar(120),
  "verification" varchar(20) NOT NULL DEFAULT 'none',
  "escalation_member_id" varchar(32),
  "next_stage" varchar(20),
  "updated_by" varchar(32) NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "stage")
);

CREATE TABLE IF NOT EXISTS "team_blueprints" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "name" varchar(140) NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "version" integer NOT NULL DEFAULT 1,
  "definition_json" jsonb NOT NULL,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_blueprints_ws_name_ver_key" ON "team_blueprints" ("workspace_id", "name", "version");

CREATE TABLE IF NOT EXISTS "workspace_roles" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "key" varchar(40) NOT NULL,
  "name" varchar(80) NOT NULL,
  "permissions_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_system" boolean NOT NULL DEFAULT false,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_roles_ws_key" ON "workspace_roles" ("workspace_id", "key");

CREATE TABLE IF NOT EXISTS "service_accounts" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "name" varchar(100) NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "scopes_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "last_used_at" timestamptz,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "service_accounts_token_key" ON "service_accounts" ("token_hash");
CREATE INDEX IF NOT EXISTS "service_accounts_ws_idx" ON "service_accounts" ("workspace_id", "revoked_at");

CREATE TABLE IF NOT EXISTS "sso_connections" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "issuer" text NOT NULL,
  "client_id" varchar(240) NOT NULL,
  "client_secret_ciphertext" text NOT NULL,
  "domains_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "default_role" varchar(40) NOT NULL DEFAULT 'member',
  "enabled" boolean NOT NULL DEFAULT true,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "sso_connections_ws_key" ON "sso_connections" ("workspace_id");

CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "actor_type" varchar(20) NOT NULL,
  "actor_id" varchar(32) NOT NULL,
  "action" varchar(100) NOT NULL,
  "target_type" varchar(40) NOT NULL,
  "target_id" varchar(64),
  "meta_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ip_hash" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "audit_events_ws_time_idx" ON "audit_events" ("workspace_id", "created_at");
