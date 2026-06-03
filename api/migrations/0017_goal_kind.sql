-- 0017_goal_kind — make "project" a first-class kind of goal.
-- Until now a "project" was just an informal top-level goal; nothing in the
-- data distinguished it. The `kind` column turns the implicit tier into a
-- real, queryable one ('project' = a top-level container, 'goal' = a unit of
-- intent the planner decomposes). Defaults to 'goal' so every existing row
-- keeps its current meaning. Idempotent.
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "kind" varchar(16) NOT NULL DEFAULT 'goal';
