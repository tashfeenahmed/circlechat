// SPDX-License-Identifier: AGPL-3.0-only
// Append-only, hash-chained log of every tool call an agent makes.
import type { DB } from "./db.ts";
import { sha256, id } from "./crypto.ts";

export interface ToolCallRecord {
  agentId: string;
  chatId?: string;
  tool: string;
  args?: unknown;
  asIdentity?: string;
  approval?: string; // "allowed" | "approved by <name>" | "blocked by rule" | "denied" | "auto (sandbox)"
  status: "ok" | "error" | "blocked" | "denied" | "pending" | "started";
  result?: string;
  costMicros?: number;
}

const GENESIS = "0".repeat(64);

function canonical(r: {
  id: string;
  agent_id: string;
  chat_id: string;
  tool: string;
  args: string;
  as_identity: string;
  approval: string;
  status: string;
  result: string;
  cost_micros: number;
  ts: number;
}): string {
  return JSON.stringify([r.id, r.agent_id, r.chat_id, r.tool, r.args, r.as_identity, r.approval, r.status, r.result, r.cost_micros, r.ts]);
}

export function appendToolCall(db: DB, rec: ToolCallRecord): string {
  const last = db.prepare("SELECT hash FROM tool_calls ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
  const prev = last?.hash ?? GENESIS;
  const row = {
    id: id("tc_"),
    agent_id: rec.agentId,
    chat_id: rec.chatId ?? "",
    tool: rec.tool,
    args: redact(JSON.stringify(rec.args ?? {})).slice(0, 4000),
    as_identity: rec.asIdentity ?? "",
    approval: rec.approval ?? "",
    status: rec.status,
    result: redact(rec.result ?? "").slice(0, 2000),
    cost_micros: rec.costMicros ?? 0,
    ts: Date.now(),
  };
  const hash = sha256(prev + canonical(row));
  db.prepare(
    `INSERT INTO tool_calls(id, agent_id, chat_id, tool, args, as_identity, approval, status, result, cost_micros, ts, prev_hash, hash)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(row.id, row.agent_id, row.chat_id, row.tool, row.args, row.as_identity, row.approval, row.status, row.result, row.cost_micros, row.ts, prev, hash);
  return row.id;
}

export function verifyChain(db: DB): { ok: boolean; count: number; brokenAt?: string } {
  const rows = db.prepare("SELECT * FROM tool_calls ORDER BY seq ASC").all() as any[];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, count: rows.length, brokenAt: r.id };
    const h = sha256(prev + canonical(r));
    if (h !== r.hash) return { ok: false, count: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}

/** Never write anything that looks like a credential into the log. */
export function redact(s: string): string {
  return s
    .replace(/(gh[pousr]_[A-Za-z0-9]{20,})/g, "[redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, "[redacted]")
    .replace(/(xox[abpr]-[A-Za-z0-9-]{10,})/g, "[redacted]")
    .replace(/("?(authorization|password|token|secret|api[_-]?key)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, "$1[redacted]");
}
