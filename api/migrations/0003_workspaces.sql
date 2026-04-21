-- ────────────────────────────────────────────────────────────────────
-- 0003_workspaces — multi-workspace support
-- ────────────────────────────────────────────────────────────────────
--
-- Users are global (a user can belong to many workspaces). Everything
-- else (members, conversations, agents, invites) is workspace-scoped.
-- Messages stay under their conversation (transitively scoped).

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id"         varchar(32) PRIMARY KEY,
  "name"       varchar(100) NOT NULL,
  "handle"     varchar(40)  NOT NULL,
  "created_by" varchar(32)  NOT NULL,
  "created_at" timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_handle_key" ON "workspaces" ("handle");

CREATE TABLE IF NOT EXISTS "workspace_members" (
  "workspace_id" varchar(32) NOT NULL,
  "user_id"      varchar(32) NOT NULL,
  "role"         varchar(20) NOT NULL DEFAULT 'member',
  "joined_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" ("user_id");

-- Scope the primary tables. DB is empty so NOT NULL without a default is fine.
ALTER TABLE "members"       ADD COLUMN IF NOT EXISTS "workspace_id" varchar(32) NOT NULL;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "workspace_id" varchar(32) NOT NULL;
ALTER TABLE "agents"        ADD COLUMN IF NOT EXISTS "workspace_id" varchar(32) NOT NULL;
ALTER TABLE "invites"       ADD COLUMN IF NOT EXISTS "workspace_id" varchar(32) NOT NULL;

-- members_kind_ref_key was (kind, ref_id) — now (workspace_id, kind, ref_id) so
-- the same user can appear under multiple workspaces with distinct member rows.
DROP INDEX IF EXISTS "members_kind_ref_key";
CREATE UNIQUE INDEX IF NOT EXISTS "members_ws_kind_ref_key"
  ON "members" ("workspace_id", "kind", "ref_id");

-- agents.handle must be unique per workspace, not globally.
DROP INDEX IF EXISTS "agents_handle_key";
CREATE UNIQUE INDEX IF NOT EXISTS "agents_ws_handle_key"
  ON "agents" ("workspace_id", "handle");

CREATE INDEX IF NOT EXISTS "conversations_ws_idx"  ON "conversations" ("workspace_id");
CREATE INDEX IF NOT EXISTS "agents_ws_idx"         ON "agents" ("workspace_id");
CREATE INDEX IF NOT EXISTS "invites_ws_idx"        ON "invites" ("workspace_id");

-- Sessions remember which workspace the user is currently viewing.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "current_workspace_id" varchar(32);
