CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS messages_body_md_trgm_idx
  ON messages USING gin (body_md gin_trgm_ops);
