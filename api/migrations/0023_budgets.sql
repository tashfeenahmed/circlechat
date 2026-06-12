-- Monthly spend budgets (Paperclip-style hard stops).
-- agents.budget_usd_month: per-agent cap; NULL = unlimited.
-- agents.pause_reason: why status=paused ('manual' | 'budget'); resume clears it.
-- *_warned_at: when the 80% soft warning last fired (dedupes to one per month).
-- agent_runs.tokens_est: estimated tokens behind cost_usd (cost is an estimate —
-- the agent runtimes call the LLM gateway directly, so we never see real usage).
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "budget_usd_month" real;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pause_reason" varchar(40);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "budget_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "budget_usd_month" real;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "budget_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "budget_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "tokens_est" integer;
