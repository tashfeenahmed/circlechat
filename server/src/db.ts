// SPDX-License-Identifier: AGPL-3.0-only
// SQLite storage (node:sqlite, no native deps). One file, WAL mode.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','admin','builder','member')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role_title TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT 'classic', colour TEXT NOT NULL DEFAULT 'coral',
  engine TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
  autonomy TEXT NOT NULL DEFAULT 'act' CHECK (autonomy IN ('ask','act','auto')),
  sandbox TEXT NOT NULL DEFAULT 'docker', email TEXT NOT NULL DEFAULT '',
  budget_cents INTEGER NOT NULL DEFAULT 0, created_by TEXT, archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('group','dm','agents')), name TEXT NOT NULL,
  created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK (member_type IN ('user','agent')), member_id TEXT NOT NULL,
  last_read_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, member_type, member_id)
);
CREATE TABLE IF NOT EXISTS chat_reads (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('user','agent','system')), author_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);

CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_id TEXT NOT NULL, scope TEXT NOT NULL, engine_session_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, scope)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, from_type TEXT NOT NULL, from_id TEXT NOT NULL,
  text TEXT NOT NULL, hop INTEGER NOT NULL DEFAULT 0, goal_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','injected','answered','failed','dropped')),
  idem TEXT UNIQUE, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_agent_state ON deliveries(agent_id, state);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', options TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','expired','cancelled')),
  decision TEXT NOT NULL DEFAULT '', decided_by TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL, args TEXT NOT NULL DEFAULT '{}', as_identity TEXT NOT NULL DEFAULT '',
  approval TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '',
  cost_micros INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('team','chat','agent')), scope_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', by_type TEXT NOT NULL, by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, forgotten_at INTEGER, forgotten_by TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, title TEXT NOT NULL,
  assignee_type TEXT NOT NULL DEFAULT '', assignee_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','working','needs_you','checking','done')),
  plan_id TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, app TEXT NOT NULL, name TEXT NOT NULL,
  identity TEXT NOT NULL CHECK (identity IN ('agent','user')), owner_user_id TEXT NOT NULL DEFAULT '',
  secret_id TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, transport TEXT NOT NULL CHECK (transport IN ('http','stdio')),
  url TEXT NOT NULL DEFAULT '', command TEXT NOT NULL DEFAULT '', args TEXT NOT NULL DEFAULT '[]',
  env_secrets TEXT NOT NULL DEFAULT '{}', tools TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'new',
  error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
-- who may use a connection or MCP server: workspace, a chat or an agent. Nothing = off everywhere.
CREATE TABLE IF NOT EXISTS grants (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('connection','mcp')), resource_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('workspace','chat','agent')), target_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (resource_type, resource_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS policies (
  resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, tool TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','ask','block','off')),
  PRIMARY KEY (resource_type, resource_id, tool)
);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('webhook','schedule')), name TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL DEFAULT '', filter TEXT NOT NULL DEFAULT '{}',
  chat_id TEXT NOT NULL, agent_id TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_run_minute TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trigger_runs (
  id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  agent_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);
-- hosted installs: one-time sign-in tokens already used (kept until they expire)
CREATE TABLE IF NOT EXISTS sso_used (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bridges (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_id TEXT NOT NULL, external_id TEXT NOT NULL,
  secret_id TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function now(): number {
  return Date.now();
}

export function getSetting(db: DB, key: string): string | undefined {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value;
}
export function setSetting(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
