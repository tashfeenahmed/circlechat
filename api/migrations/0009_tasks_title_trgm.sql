-- Trigram index on tasks.title so the executor can cheaply check
-- "is this a near-duplicate of a task created in the last 24h?" before
-- letting an agent spawn create_task again. Stops the heartbeat-driven
-- duplicate task plague (3x voiceover, 5x DNS record, etc.) at the source.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "tasks_title_trgm_idx" ON "tasks" USING gin ("title" gin_trgm_ops);
