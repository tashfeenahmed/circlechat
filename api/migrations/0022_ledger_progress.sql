-- Typed per-round Progress Ledger + loop counter on goal_ledgers, so stall/loop
-- detection has an explicit is_in_loop / is_progress_being_made signal instead
-- of depending only on a wall-clock progress gap. Idempotent (ADD COLUMN IF NOT
-- EXISTS) to stay safe against the known drizzle journal/reality drift.
ALTER TABLE "goal_ledgers" ADD COLUMN IF NOT EXISTS "progress_ledger" jsonb;
ALTER TABLE "goal_ledgers" ADD COLUMN IF NOT EXISTS "loop_count" integer DEFAULT 0 NOT NULL;
