-- Task artifacts: a first-class, versioned, attributed deliverables namespace
-- owned by each task. Replaces burying deliverables inside
-- task_comments.attachments_json (not queryable / not versioned / not the
-- source of truth). Submitted only through the CircleChat API (agent or human),
-- never via a raw filesystem path. IF NOT EXISTS so this is safe to also apply
-- directly on a box whose drizzle journal has drifted.
CREATE TABLE IF NOT EXISTS task_artifacts (
  id            varchar(32) PRIMARY KEY,
  task_id       varchar(32) NOT NULL,
  workspace_id  varchar(32) NOT NULL,
  name          varchar(200) NOT NULL,      -- logical filename, unique per (task, version)
  version       integer NOT NULL DEFAULT 1, -- increments per (task_id, name)
  storage_key   varchar(300) NOT NULL,      -- object-store key: t/<task_id>/<artifact_id>/<safeName>
  content_type  varchar(160) NOT NULL DEFAULT 'application/octet-stream',
  size          integer NOT NULL DEFAULT 0,
  sha256        varchar(64),                -- content hash (dedupe + integrity)
  created_by    varchar(32) NOT NULL,       -- member_id (agent OR user)
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS task_artifacts_task_idx ON task_artifacts (task_id, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS task_artifacts_task_name_ver ON task_artifacts (task_id, name, version);
