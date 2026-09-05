// Approval policy: the rules that decide whether an agent's ask needs a human
// at all, whether it duplicates one already asked, and what happens when no
// human ever answers.
//
// Why this exists. On the live fishbowl, five credential cards sat `pending`
// for two months. Agents re-requested the same key after it was DENIED (the
// dedupe matched free text only, never the scope), 12 tasks stayed `blocked`
// on cards nobody was ever notified about, and nothing expired — so the loop
// had no exit. The pieces here give it three:
//   • dedupe by SCOPE and credential NAME, not just text similarity, and
//     remember denials/expiries for a configurable window;
//   • expire stale cards (APPROVAL_TTL_HOURS), wake the agent with status
//     "expired — find another route", and release the tasks blocked on it;
//   • a small auto-approval layer (AUTO_APPROVE_SCOPES, per-agent
//     `approve:<scope>` scopes) that records an audit row instead of a card.
//
// Pure helpers are exported for tests; the DB-touching sweep lives at the
// bottom so the worker owner can call it from the periodic tick.
import { and, eq, gt, ilike, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, approvals, members, taskComments, tasks } from "../db/schema.js";
import { approvalDenialMemoryDays, approvalTtlHours, autoApproveScopes } from "./config.js";
import { publishToConversation, publishToWorkspace } from "./events.js";
import { enqueueAgentEvent } from "../agents/enqueue.js";
import { notifyApprovers } from "./notifications.js";
import { addComment, updateTask } from "./tasks-core.js";

// ───────────────── pure helpers ─────────────────

// Same detector the Approvals page and the bridge use: a request whose scope
// or text names a credential. These can never be auto-approved (approving
// produces no secret) and are what the dedupe must catch by name.
export const CREDENTIAL_ASK_RE =
  /credential|token|api.?key|secret|password|passphrase|access.?key|\bpat\b/i;

export function isCredentialAsk(scope: string, action: string): boolean {
  return CREDENTIAL_ASK_RE.test(`${scope || ""} ${action || ""}`);
}

// `Tavily API key`, `tavily-api-key`, `TAVILY_API_KEY` → `tavily_api_key`.
export function normalizeScope(scope: string): string {
  return (scope || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9*:.]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

// Env-var-shaped credential names mentioned in a scope/action, upper-cased
// and deduped: "VERCEL_TOKEN", "TAVILY_API_KEY", "GITHUB_PAT". The scope is
// upper-cased first so `tavily_api_key` counts. Used to match a re-request
// for the same secret regardless of how the sentence around it is phrased.
const CRED_NAME_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_)?(?:KEY|TOKEN|SECRET|PAT|PASSWORD|CREDENTIALS?)\b/g;
export function credentialNames(scope: string, action: string): string[] {
  const hay = `${(scope || "").toUpperCase()} ${action || ""}`;
  const out = new Set<string>();
  for (const m of hay.match(CRED_NAME_RE) ?? []) out.add(m);
  return Array.from(out);
}

// Does an AUTO_APPROVE_SCOPES entry (or an agent's `approve:<x>` scope) cover
// this approval scope? Exact match after normalisation, or prefix match with
// a trailing `*` (`tasks.*`, `risk:*`, `deploy*`). A bare `*` covers all.
export function scopeMatches(pattern: string, scope: string): boolean {
  const p = normalizeScope(pattern);
  const s = normalizeScope(scope);
  if (!p || !s) return false;
  if (p === "*") return true;
  if (p.endsWith("*")) return s.startsWith(p.slice(0, -1));
  return p === s;
}

// Why an approval may skip the human, or null when it must not.
//   • credential asks: never (there is nothing to deliver);
//   • AUTO_APPROVE_SCOPES covers the scope → "policy";
//   • the agent holds `approve:<scope>` or `approve:*` → "agent_scope".
// Agents' `approve:` scopes are the per-agent trust level: they live in the
// existing `agents.scopes` column and are edited from the same UI as the
// action scopes, so no schema change is needed.
export type AutoApproval = { by: "policy" | "agent_scope"; rule: string };
export function autoApprovalFor(
  scope: string,
  action: string,
  agentScopes: string[] | null | undefined,
  envList: string[] = autoApproveScopes(),
): AutoApproval | null {
  if (isCredentialAsk(scope, action)) return null;
  for (const rule of envList) if (scopeMatches(rule, scope)) return { by: "policy", rule };
  for (const s of agentScopes ?? []) {
    const m = /^approve:(.+)$/i.exec(s.trim());
    if (m && scopeMatches(m[1], scope)) return { by: "agent_scope", rule: s.trim() };
  }
  return null;
}

export function approvalTtlMs(hours: number = approvalTtlHours()): number {
  return hours > 0 ? hours * 60 * 60 * 1000 : 0;
}

export function approvalExpiresAt(createdAt: Date, hours: number = approvalTtlHours()): Date | null {
  const ms = approvalTtlMs(hours);
  return ms > 0 ? new Date(createdAt.getTime() + ms) : null;
}

export function isApprovalExpired(createdAt: Date, now: Date = new Date(), hours: number = approvalTtlHours()): boolean {
  const at = approvalExpiresAt(createdAt, hours);
  return !!at && at.getTime() <= now.getTime();
}

export function denialMemoryMs(days: number = approvalDenialMemoryDays()): number {
  return Math.max(0, days) * 24 * 60 * 60 * 1000;
}

// The decision note written on an expired card. It is what the agent reads
// on its approval_response wake (context.ts forwards decisionNote verbatim),
// so it carries the full instruction, not just a status word.
export function expiryNote(hours: number = approvalTtlHours()): string {
  return (
    `EXPIRED: no human decided this within ${hours}h. Treat it as unavailable — do NOT re-request or rephrase it ` +
    `(the server refuses equivalent requests for ${approvalDenialMemoryDays()} days). Pick a route that does not need it: ` +
    `use a built-in alternative (e.g. share_to_task + the in-platform app preview instead of an external host, ` +
    `a keyless/public data source instead of a paid API), scope the work down to what you CAN finish, or hand the task ` +
    `back with one comment explaining the dependency. Any task blocked on this has been moved back to in_progress.`
  );
}

// ───────────────── dedupe ─────────────────
// Exact agent+scope+action matching got beaten in the wild: agents minted a
// fresh free-form scope string every wake (github_auth, hosting, deploy_creds,
// github_token, …) for the SAME ask, so 11 cards piled up. Then text-similarity
// matching got beaten too: TAVILY_API_KEY was denied and re-requested twice
// with different sentences around the same scope. So a request duplicates an
// existing one when ANY of these hold, workspace-wide:
//   • the normalised scope is identical;
//   • they name the same credential (VERCEL_TOKEN, TAVILY_API_KEY, …);
//   • the action text is similar (pg_trgm; looser for the same agent).
// Pending cards, and denied/expired ones inside the memory window, all count.
const DUP_SIM_SELF = 0.45;
const DUP_SIM_TEAMMATE = 0.62;

export type DuplicateApproval = {
  id: string;
  status: string;
  agentId: string;
  decidedAt: Date | null;
  decisionNote: string | null;
  action: string;
  scope: string;
};

type Candidate = DuplicateApproval & { sim: number | string | null };

// Pure ranking over fetched candidates (exported for tests).
export function pickDuplicate(
  candidates: Candidate[],
  req: { agentId: string; scope: string; action: string },
): DuplicateApproval | null {
  const scope = normalizeScope(req.scope);
  const names = new Set(credentialNames(req.scope, req.action));
  let best: { row: Candidate; rank: number } | null = null;
  for (const r of candidates) {
    let rank = 0;
    if (scope && normalizeScope(r.scope) === scope) rank = 3;
    else if (names.size && credentialNames(r.scope, r.action).some((n) => names.has(n))) rank = 2;
    else {
      const sim = Number(r.sim ?? 0);
      const threshold = r.agentId === req.agentId ? DUP_SIM_SELF : DUP_SIM_TEAMMATE;
      if (sim >= threshold) rank = 1;
    }
    if (!rank) continue;
    // Prefer a decided (denied/expired) match over a pending one at equal
    // rank: a final answer beats "still waiting".
    const decidedBoost = r.status === "pending" ? 0 : 0.5;
    if (!best || rank + decidedBoost > best.rank) best = { row: r, rank: rank + decidedBoost };
  }
  if (!best) return null;
  const { sim: _sim, ...row } = best.row;
  return row;
}

export async function findDuplicateApproval(
  agentId: string,
  scope: string,
  action: string,
): Promise<DuplicateApproval | null> {
  const [me] = await db
    .select({ workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!me) return null;
  const memoryCutoff = new Date(Date.now() - denialMemoryMs());
  const normScope = normalizeScope(scope);
  const names = credentialNames(scope, action).slice(0, 4);
  const textMatch = [
    sql`similarity(${approvals.action}, ${action}) > ${DUP_SIM_SELF}`,
    ...(normScope ? [sql`lower(regexp_replace(${approvals.scope}, '[^a-zA-Z0-9*:.]+', '_', 'g')) = ${normScope}`] : []),
    ...names.map((n) => ilike(approvals.action, `%${n}%`)),
    ...names.map((n) => ilike(approvals.scope, `%${n}%`)),
  ];
  const rows = await db
    .select({
      id: approvals.id,
      status: approvals.status,
      agentId: approvals.agentId,
      decidedAt: approvals.decidedAt,
      decisionNote: approvals.decisionNote,
      action: approvals.action,
      scope: approvals.scope,
      sim: sql<number>`similarity(${approvals.action}, ${action})`.as("sim"),
    })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(
      and(
        eq(agents.workspaceId, me.workspaceId),
        or(
          eq(approvals.status, "pending"),
          and(or(eq(approvals.status, "denied"), eq(approvals.status, "expired")), gt(approvals.decidedAt, memoryCutoff)),
        ),
        or(...textMatch),
      ),
    )
    .orderBy(sql`similarity(${approvals.action}, ${action}) desc`)
    .limit(10);
  return pickDuplicate(rows, { agentId, scope, action });
}

// Actionable rejection copy for a duplicate match. Returned as an executor
// error so the agent reads WHY it was dropped and what to do instead. The
// previous human note rides along on a denial — it is the answer.
export function duplicateApprovalError(actionType: string, dup: DuplicateApproval, agentId: string): string {
  const when = dup.decidedAt ? dup.decidedAt.toISOString().slice(0, 10) : "recently";
  const note = dup.decisionNote ? ` Their note: "${dup.decisionNote}".` : "";
  if (dup.status === "denied") {
    return (
      `${actionType} refused: a human DENIED an equivalent request (${dup.id}, "${dup.action}") on ${when}.${note} ` +
      `A denial is final — do NOT re-request or rephrase it. Set the dependent task status:"blocked" with one comment, or pursue an approach that doesn't need this approval.`
    );
  }
  if (dup.status === "expired") {
    return (
      `${actionType} refused: an equivalent request (${dup.id}, "${dup.action}") EXPIRED on ${when} with no human decision. ` +
      `Do NOT re-request it — it will not be answered. Find a route that doesn't need it (built-in alternatives, a smaller scope, or hand the task back with one comment).`
    );
  }
  if (dup.agentId !== agentId) {
    return (
      `${actionType} skipped: a teammate already has an equivalent approval pending (${dup.id}, "${dup.action}"). ` +
      `Don't file duplicates — the human decides once for the team. Coordinate on the task card if needed.`
    );
  }
  return (
    `${actionType} skipped: your equivalent approval (${dup.id}) is already pending a human decision — ` +
    `do not retry or rephrase it; you'll be woken with trigger:"approval_response" when it's decided.`
  );
}

// ───────────────── expiry sweep ─────────────────

// Release the tasks an agent parked on this approval. A task counts as tied
// to the card when its body or a comment quotes the approval id (the agents
// write "blocked pending approval of X (ap_…)" on the card). Each is moved
// back to in_progress with one comment so the board reflects reality and the
// agent's next wake sees live work, not a blocked card it must not touch.
export async function unblockTasksForApproval(
  approvalId: string,
  workspaceId: string,
  actorMemberId: string,
  note: string,
): Promise<string[]> {
  const needle = `%${approvalId}%`;
  const rows = await db
    .selectDistinct({ id: tasks.id })
    .from(tasks)
    .leftJoin(taskComments, and(eq(taskComments.taskId, tasks.id), ilike(taskComments.bodyMd, needle)))
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.status, "blocked"),
        eq(tasks.archived, false),
        or(ilike(tasks.bodyMd, needle), sql`${taskComments.id} is not null`),
      ),
    )
    .limit(50);
  const released: string[] = [];
  for (const t of rows) {
    const upd = await updateTask(t.id, { status: "in_progress" }, actorMemberId, workspaceId).catch(() => ({ error: "update_failed" }));
    if ("error" in upd && upd.error) continue;
    await addComment(t.id, note, [], actorMemberId, workspaceId).catch(() => {});
    released.push(t.id);
  }
  return released;
}

// Mark stale pending approvals expired, wake their agents, release blocked
// tasks, and tell the approvers. Idempotent and race-safe (each row is
// claimed with a status-guarded UPDATE), so it can run on every worker tick.
// Returns the number of approvals expired. No-op when APPROVAL_TTL_HOURS=0.
export async function expireStaleApprovals(now: Date = new Date()): Promise<number> {
  const hours = approvalTtlHours();
  const ttl = approvalTtlMs(hours);
  if (ttl <= 0) return 0;
  const cutoff = new Date(now.getTime() - ttl);
  const stale = await db
    .select({
      id: approvals.id,
      agentId: approvals.agentId,
      conversationId: approvals.conversationId,
      scope: approvals.scope,
      action: approvals.action,
      workspaceId: agents.workspaceId,
      agentName: agents.name,
    })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(and(eq(approvals.status, "pending"), lt(approvals.createdAt, cutoff)))
    .limit(100);
  let n = 0;
  for (const ap of stale) {
    const note = expiryNote(hours);
    const claimed = await db
      .update(approvals)
      .set({ status: "expired", decidedAt: now, decidedBy: null, decisionNote: note })
      .where(and(eq(approvals.id, ap.id), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (!claimed.length) continue;
    n++;
    const frame = { type: "approval.decided" as const, approvalId: ap.id, status: "expired" };
    await publishToWorkspace(ap.workspaceId, frame).catch(() => {});
    if (ap.conversationId) await publishToConversation(ap.conversationId, frame).catch(() => {});

    const [agentMember] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.workspaceId, ap.workspaceId), eq(members.kind, "agent"), eq(members.refId, ap.agentId)))
      .limit(1);
    let released: string[] = [];
    if (agentMember) {
      released = await unblockTasksForApproval(
        ap.id,
        ap.workspaceId,
        agentMember.id,
        `Approval ${ap.id} ("${ap.action}") expired after ${hours}h with no human decision. Unblocked automatically — the assignee will pursue a route that does not need it or hand the task back.`,
      ).catch(() => []);
    }
    await enqueueAgentEvent(ap.agentId, {
      trigger: "approval_response",
      approvalId: ap.id,
      status: "expired",
      conversationId: ap.conversationId ?? undefined,
    }).catch((e) => console.error("[approvals] expiry wake failed", (e as Error).message));
    await notifyApprovers(ap.workspaceId, {
      kind: "system",
      title: `Approval expired: ${ap.agentName} — ${ap.scope}`,
      body:
        `"${ap.action}" waited ${hours}h without a decision and was closed. The agent has been told to find another route` +
        (released.length ? `; ${released.length} blocked task(s) were moved back to in progress.` : "."),
      link: "/approvals",
    });
    console.log(`[approvals] expired ${ap.id} (${ap.scope}) agent=${ap.agentId} released=${released.length}`);
  }
  return n;
}
