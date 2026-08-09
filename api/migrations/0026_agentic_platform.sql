-- P0 agentic-platform foundation: governed connector/MCP registry, durable
-- workflows and waits, signed incoming webhooks, and actual model usage.

CREATE TABLE IF NOT EXISTS "connectors" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "name" varchar(120) NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "kind" varchar(16) NOT NULL,
  "base_url" text NOT NULL,
  "auth_type" varchar(20) NOT NULL DEFAULT 'none',
  "config_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "secret_ciphertext" text,
  "status" varchar(20) NOT NULL DEFAULT 'unchecked',
  "last_checked_at" timestamptz,
  "last_error" text,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "connectors_kind_check" CHECK ("kind" IN ('http', 'mcp')),
  CONSTRAINT "connectors_auth_check" CHECK ("auth_type" IN ('none', 'bearer', 'header', 'oauth2'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "connectors_ws_name_key" ON "connectors" ("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "connectors_ws_idx" ON "connectors" ("workspace_id", "status");

CREATE TABLE IF NOT EXISTS "agent_connector_grants" (
  "connector_id" varchar(32) NOT NULL,
  "agent_id" varchar(32) NOT NULL,
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("connector_id", "agent_id")
);
CREATE INDEX IF NOT EXISTS "agent_connector_grants_agent_idx" ON "agent_connector_grants" ("agent_id");

CREATE TABLE IF NOT EXISTS "workflows" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "name" varchar(140) NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "trigger_type" varchar(20) NOT NULL DEFAULT 'manual',
  "definition_json" jsonb NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workflows_status_check" CHECK ("status" IN ('active', 'paused')),
  CONSTRAINT "workflows_trigger_check" CHECK ("trigger_type" IN ('manual', 'webhook'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflows_ws_name_key" ON "workflows" ("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "workflows_ws_idx" ON "workflows" ("workspace_id", "status");

CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" varchar(32) PRIMARY KEY,
  "workflow_id" varchar(32) NOT NULL,
  "workspace_id" varchar(32) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'queued',
  "current_state_id" varchar(80),
  "input_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "wait_kind" varchar(20),
  "wait_key" varchar(100),
  "wait_until" timestamptz,
  "error_text" text,
  "created_by" varchar(32) NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "workflow_runs_status_check" CHECK ("status" IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS "workflow_runs_workflow_idx" ON "workflow_runs" ("workflow_id", "started_at");
CREATE INDEX IF NOT EXISTS "workflow_runs_ws_status_idx" ON "workflow_runs" ("workspace_id", "status");

CREATE TABLE IF NOT EXISTS "workflow_steps" (
  "id" varchar(32) PRIMARY KEY,
  "run_id" varchar(32) NOT NULL,
  "state_id" varchar(80) NOT NULL,
  "kind" varchar(20) NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "status" varchar(20) NOT NULL DEFAULT 'running',
  "input_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "agent_run_id" varchar(32),
  "error_text" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_steps_run_state_attempt_key" ON "workflow_steps" ("run_id", "state_id", "attempt");
CREATE INDEX IF NOT EXISTS "workflow_steps_run_idx" ON "workflow_steps" ("run_id", "started_at");

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "workflow_id" varchar(32) NOT NULL,
  "name" varchar(120) NOT NULL,
  "secret_ciphertext" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_by" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "webhook_endpoints_workflow_idx" ON "webhook_endpoints" ("workflow_id");

CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id" varchar(32) PRIMARY KEY,
  "endpoint_id" varchar(32) NOT NULL,
  "delivery_id" varchar(120) NOT NULL,
  "signature_valid" boolean NOT NULL DEFAULT false,
  "status" varchar(20) NOT NULL DEFAULT 'received',
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "workflow_run_id" varchar(32),
  "error_text" text,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_endpoint_delivery_key" ON "webhook_events" ("endpoint_id", "delivery_id");
CREATE INDEX IF NOT EXISTS "webhook_events_endpoint_idx" ON "webhook_events" ("endpoint_id", "received_at");

CREATE TABLE IF NOT EXISTS "model_routes" (
  "workspace_id" varchar(32) NOT NULL,
  "tier" varchar(20) NOT NULL,
  "provider" varchar(60) NOT NULL,
  "model" varchar(120) NOT NULL,
  "input_cost_per_mtok" real NOT NULL DEFAULT 0,
  "output_cost_per_mtok" real NOT NULL DEFAULT 0,
  "cached_input_cost_per_mtok" real NOT NULL DEFAULT 0,
  "context_window" integer,
  "enabled" boolean NOT NULL DEFAULT true,
  "updated_by" varchar(32) NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "tier"),
  CONSTRAINT "model_routes_tier_check" CHECK ("tier" IN ('economy', 'balanced', 'frontier', 'advisor'))
);

CREATE TABLE IF NOT EXISTS "model_usage_events" (
  "id" varchar(32) PRIMARY KEY,
  "workspace_id" varchar(32) NOT NULL,
  "agent_id" varchar(32) NOT NULL,
  "run_id" varchar(32) NOT NULL,
  "event_key" varchar(80) NOT NULL,
  "provider" varchar(60) NOT NULL DEFAULT 'unknown',
  "model" varchar(120) NOT NULL DEFAULT 'unknown',
  "route_tier" varchar(20),
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cached_input_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd" real NOT NULL DEFAULT 0,
  "source" varchar(20) NOT NULL DEFAULT 'reported',
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "model_usage_source_check" CHECK ("source" IN ('reported', 'estimated'))
);
CREATE INDEX IF NOT EXISTS "model_usage_events_run_idx" ON "model_usage_events" ("run_id");
CREATE UNIQUE INDEX IF NOT EXISTS "model_usage_events_run_event_key" ON "model_usage_events" ("run_id", "event_key");
CREATE INDEX IF NOT EXISTS "model_usage_events_ws_time_idx" ON "model_usage_events" ("workspace_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "model_usage_events_agent_time_idx" ON "model_usage_events" ("agent_id", "occurred_at");
