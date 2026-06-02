-- Workflow layer: an optional `condition` on a task link turns a `blocks` edge
-- into a decision/branch edge.
--   • An UNCONDITIONAL `blocks` edge (A→B, condition NULL) is a hard dependency
--     — an AND-join: B stays blocked until A (and every other unconditional
--     blocker) reaches `done`.
--   • A CONDITIONAL `blocks` edge (A→B, condition='approved') is an OR-activation
--     — when A completes carrying a label equal to `condition`, B is auto-started,
--     letting an agent's labelled outcome pick which downstream branch runs.
-- Nullable, so every existing link stays an unconditional dependency. Idempotent.
ALTER TABLE "task_links" ADD COLUMN IF NOT EXISTS "condition" varchar(60);
