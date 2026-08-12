-- Expire capability-bearing invite links. Existing outstanding invites get a
-- bounded grace period based on their original creation time.
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
UPDATE "invites"
SET "expires_at" = "created_at" + interval '7 days'
WHERE "expires_at" IS NULL;
ALTER TABLE "invites" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '7 days');
ALTER TABLE "invites" ALTER COLUMN "expires_at" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "invites_expires_idx" ON "invites" ("expires_at");
