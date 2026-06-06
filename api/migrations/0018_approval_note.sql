-- 0018_approval_note — let the human attach an optional comment when deciding
-- an approval. The note rides the approval_response wake back to the agent
-- ("approved, but only send to the staging list" / "denied — use the shared
-- drive instead"), so a decision can carry guidance instead of being a bare
-- yes/no the agent has to guess around.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision_note text;
