-- Condensation-as-event for long task threads (OpenHands condenser pattern).
-- A task's context shows only the most recent N comments; once a thread grows
-- past that window the earlier "why/what-was-tried" is invisible and agents
-- re-derive or repeat. This stores a rolling summary of the OLDER comments so
-- the agent sees [summary of comments 1..k] + [recent N] instead of losing the
-- head. comment_count = how many comments the summary covers; through_ts = the
-- timestamp of the newest summarized comment (the boundary with the live tail).
CREATE TABLE IF NOT EXISTS "task_summaries" (
  "task_id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "summary" text NOT NULL DEFAULT '',
  "comment_count" integer NOT NULL DEFAULT 0,
  "through_ts" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
