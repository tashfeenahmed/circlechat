-- 0019_approval_secrets — record WHICH secrets (env-var names only, never
-- values) were delivered to the agent's environment when an approval was
-- granted. The values themselves go straight into the agent home's .env and
-- are never persisted in the database; this column lets the approval_response
-- wake tell the agent "GITHUB_TOKEN is now in your env" and lets the UI show
-- that credentials were attached.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS delivered_secrets jsonb;
