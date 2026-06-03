-- Automatic planning: goals decompose themselves instead of waiting for a
-- manual "Plan" click. `workspaces.auto_plan` is the policy ('auto' | 'off');
-- `goals.plan_attempts` + `last_plan_error` let the sweeper retry-with-backoff
-- and give up after a cap rather than loop. Idempotent.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_plan" varchar(10) NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "plan_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "last_plan_error" text;
