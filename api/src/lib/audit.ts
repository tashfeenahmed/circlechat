// Best-effort audit trail.
//
// `audit_events` had a single writer (access-control.writeAudit, called from
// the SSO/service-account admin routes) and therefore ZERO rows on the live
// deployment — the enterprise audit export at GET /enterprise/audit returned an
// empty list for a workspace that had run thousands of agent actions. This
// module is the cheap, uniform way every interesting lifecycle event gets a
// row: ONE insert, fire-and-forget, never able to throw into a request path or
// a worker tick.
//
// Volume discipline. Audit is a governance log, not a metrics firehose, so we
// only record decisions and state transitions a human would ever want to
// reconstruct: task/goal status changes, approvals created/decided/expired,
// verification verdicts, artifact create/delete, and agent runs that FAILED
// (successful runs are already in agent_runs and would dwarf everything else).
import { db } from "../db/index.js";
import { auditEvents } from "../db/schema.js";
import { id } from "./ids.js";

// The action vocabulary. Kept as a union so a typo can't silently create a new
// action name that no reader knows about.
export type AuditAction =
  | "task.status_changed"
  | "goal.status_changed"
  | "approval.created"
  | "approval.decided"
  | "approval.expired"
  | "approval.auto_approved"
  | "verification.verdict"
  | "artifact.created"
  | "artifact.deleted"
  | "agent_run.failed";

export interface AuditInput {
  workspaceId: string;
  /** Member id of whoever caused it; "system" for sweeps with no human/agent actor. */
  actorId: string;
  actorType?: "user" | "agent" | "service" | "system";
  action: AuditAction;
  targetType: "task" | "goal" | "approval" | "artifact" | "verification" | "agent_run";
  targetId?: string | null;
  meta?: Record<string, unknown>;
}

// audit_events.actor_id is varchar(32); a missing actor becomes the literal
// "system" so the column stays NOT NULL and the reader can filter on it.
const SYSTEM_ACTOR = "system";

/**
 * Record one audit event. Never throws and never awaits anything the caller
 * depends on — call it with `void audit({...})` from a hot path, or `await` it
 * where ordering matters (it still swallows its own failures).
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      id: id("audit"),
      workspaceId: input.workspaceId,
      actorType: input.actorType ?? (input.actorId && input.actorId !== SYSTEM_ACTOR ? "user" : "system"),
      actorId: (input.actorId || SYSTEM_ACTOR).slice(0, 32),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ? input.targetId.slice(0, 64) : null,
      metaJson: clampMeta(input.meta ?? {}),
      ipHash: null,
    });
  } catch {
    // An audit row is never worth failing a request or a worker tick over.
  }
}

// Keep meta small and free of anything secret-shaped. Values are truncated so
// one huge rationale/payload can't bloat the table or the CSV export.
const MAX_META_STRING = 600;
const SECRETISH = /key|token|secret|password|credential|authorization/i;
export function clampMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRETISH.test(k)) continue;
    if (typeof v === "string") out[k] = v.length > MAX_META_STRING ? `${v.slice(0, MAX_META_STRING)}…` : v;
    else if (v === null || ["number", "boolean"].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === "string" ? x.slice(0, 120) : x));
    else if (v !== undefined) out[k] = JSON.stringify(v).slice(0, MAX_META_STRING);
  }
  return out;
}
