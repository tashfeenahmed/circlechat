-- Scope agent memory by global / per-conversation / per-task so agents can
-- carry channel-specific context (e.g. "this channel prefers terse replies")
-- and task-specific notes (e.g. "investigated CDN issue, ruled out DNS") in
-- separate keyspaces. Existing rows become global-scoped.

ALTER TABLE "memory_kv" DROP CONSTRAINT "memory_kv_pk";
ALTER TABLE "memory_kv" ADD COLUMN IF NOT EXISTS "scope" varchar(20) NOT NULL DEFAULT 'global';
ALTER TABLE "memory_kv" ADD COLUMN IF NOT EXISTS "scope_id" varchar(32) NOT NULL DEFAULT '';
ALTER TABLE "memory_kv" ADD CONSTRAINT "memory_kv_pk" PRIMARY KEY ("agent_id", "scope", "scope_id", "key");
CREATE INDEX IF NOT EXISTS "memory_kv_scope_idx" ON "memory_kv" ("agent_id", "scope", "scope_id");
