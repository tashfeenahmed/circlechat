-- Pinned messages (Slack/Discord parity). A pinned row keeps a message
-- reachable from the channel header even after it scrolls out of history.
-- NULL = not pinned; the pinner is recorded so the hoverbar can show who
-- pinned it. Partial index keeps "list the pins of this channel" cheap.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "pinned_at" timestamptz;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "pinned_by" varchar(32);
CREATE INDEX IF NOT EXISTS "messages_pinned_idx" ON "messages" ("conversation_id", "pinned_at");
