-- Workspace-level mission text. Inherited by every agent in the workspace
-- via the runtime prompt — so the team only has to describe "what we build"
-- once instead of repeating it in every per-agent brief. Empty by default.

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "mission" text NOT NULL DEFAULT '';
