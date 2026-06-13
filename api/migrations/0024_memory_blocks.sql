-- Letta-style memory blocks: labeled prose compiled into EVERY agent prompt,
-- self-edited by the agent, and (when shared) attached to every agent in the
-- workspace so it acts as a live "team whiteboard" instead of each agent
-- re-deriving project state from chat scrollback. Distinct from memory_kv
-- (scoped, selectively-injected key/value scratch): blocks are always in
-- context, char-limited, and shareable by id.
CREATE TABLE IF NOT EXISTS "memory_blocks" (
  "id" varchar(40) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "value" text NOT NULL DEFAULT '',
  "char_limit" integer NOT NULL DEFAULT 2000,
  "shared" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" varchar(32)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_blocks_ws_idx" ON "memory_blocks" ("workspace_id");--> statement-breakpoint
-- One block can be attached to many agents (shared); each agent names it with a
-- label that is unique within that agent (its agent-local handle for the block).
CREATE TABLE IF NOT EXISTS "agent_memory_blocks" (
  "agent_id" varchar(32) NOT NULL,
  "label" varchar(40) NOT NULL,
  "block_id" varchar(40) NOT NULL,
  PRIMARY KEY ("agent_id", "label")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_blocks_block_idx" ON "agent_memory_blocks" ("block_id");
