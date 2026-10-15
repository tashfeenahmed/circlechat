-- Saved items ("Save for later"). Slack and Discord both let a member keep a
-- private list of messages to come back to; pins are a CHANNEL act (shared,
-- one list, header-visible) while a save is PERSONAL (no one else sees it, it
-- survives leaving nothing behind in the channel). One row per (message,
-- member): the PK is the toggle — insert saves, delete unsaves.
CREATE TABLE IF NOT EXISTS "saved_items" (
  "message_id" varchar(32) NOT NULL,
  "member_id" varchar(32) NOT NULL,
  "saved_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "saved_items_pk" PRIMARY KEY ("message_id", "member_id")
);

-- "List MY saved items, newest first" — the page that reads this table always
-- filters by member and orders by time.
CREATE INDEX IF NOT EXISTS "saved_items_member_idx" ON "saved_items" ("member_id", "saved_at");
