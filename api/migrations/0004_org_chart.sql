-- 0004_org_chart — reporting hierarchy (single-parent tree per workspace)
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "reports_to" varchar(32);
CREATE INDEX IF NOT EXISTS "members_reports_to_idx"
  ON "members" ("workspace_id", "reports_to");
