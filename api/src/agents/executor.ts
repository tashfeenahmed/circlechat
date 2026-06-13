import { and, eq, gt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  messages,
  reactions,
  approvals,
  members,
  conversations,
  conversationMembers,
  memoryKv,
  tasks,
  agents,
} from "../db/schema.js";
import { id } from "../lib/ids.js";
import { publishToConversation } from "../lib/events.js";
import { checkReplyBody, guardRejectHint } from "./reply-guard.js";
import { checkRecentDuplicate, checkRecentDuplicateTaskComment } from "./dedupe.js";
import {
  extractMentionHandles,
  resolveHandlesToMemberIds,
  fireMentionTriggers,
} from "./mention-triggers.js";
import {
  createTask,
  updateTask,
  addAssignee,
  addComment,
  loadTask,
} from "../lib/tasks-core.js";
import { createGoal } from "../lib/goals-core.js";
import { planGoal } from "../lib/planner.js";
import { latestVerificationRationale } from "../lib/task-verifier.js";
import { editAgentBlock } from "../lib/memory-blocks.js";
import { loadLedger, appendFact, appendProgressNote, appendDeadEnd } from "../lib/ledger-core.js";
import { putObject, publicUrl, readObject } from "../lib/storage.js";
import { createArtifact, isSubstantiveContent } from "../lib/task-artifacts.js";
import { notifyForMessage } from "../lib/notifications.js";

export interface AgentAttachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

export type AgentAction =
  | { type: "post_message"; conversation_id: string; body_md: string; reply_to?: string; attachments?: AgentAttachment[] }
  | { type: "react"; message_id: string; emoji: string }
  | { type: "open_thread"; message_id: string; body_md: string }
  | { type: "request_approval"; scope: string; action: string; conversation_id?: string; payload?: Record<string, unknown> }
  | {
      type: "set_memory";
      key: string;
      value: unknown;
      scope?: "global" | "conversation" | "task";
      scope_id?: string;
    }
  | {
      type: "delete_memory";
      key: string;
      scope?: "global" | "conversation" | "task";
      scope_id?: string;
    }
  // In-context memory blocks (Letta-style): always-visible prose the agent
  // self-maintains. `label` is "team" (shared whiteboard) or "notes" (private).
  | { type: "memory_append"; label: string; text: string }
  | { type: "memory_rethink"; label: string; value: string }
  | { type: "call_tool"; name: string; args?: unknown }
  // Task-board actions — let the agent runtime emit structured calls instead
  // of round-tripping curl through its terminal skill. Field names mirror the
  // `/agent-api/tasks` HTTP route bodies for consistency.
  | {
      type: "create_task";
      title: string;
      body_md?: string;
      status?: "backlog" | "in_progress" | "blocked" | "review" | "done";
      parent_id?: string;
      goal_id?: string;
      conversation_id?: string;
      assignees?: string[];
      labels?: string[];
      due_at?: string;
    }
  | {
      type: "update_task";
      task_id: string;
      title?: string;
      body_md?: string;
      status?: "backlog" | "in_progress" | "blocked" | "review" | "done";
      progress?: number;
      due_at?: string | null;
      archived?: boolean;
    }
  | { type: "assign_task"; task_id: string; member_id: string }
  // Goal actions — set a goal and have the planner auto-decompose it into a
  // delegation tree of tasks routed across the team (the manager move).
  | { type: "create_goal"; title: string; body_md?: string; parent_goal_id?: string; kind?: "goal" | "project" }
  | { type: "decompose_goal"; goal_id: string }
  // Goal ledger — append durable facts/progress/dead-ends to a goal's shared
  // ledger so teammates (and your future self) read them instead of digging
  // through chat. The Magentic-One "task + progress ledger" the team works off.
  | { type: "ledger_update"; goal_id: string; facts?: string[]; progress_note?: string; dead_end?: string }
  | {
      type: "task_comment";
      task_id: string;
      body_md: string;
      mentions?: string[];
      attachments?: AgentAttachment[];
    }
  // Fetch one or more URLs server-side OR pick up files the agent wrote to
  // /tmp, then post them as attachments. Saves the agent from a six-step
  // shell ritual (urllib/tempfile/multipart/parse/<attachments> block) for
  // the common "share a photo from the web" and "browser pdf /tmp/x.pdf
  // then send it" flows. Without this, faced with the friction, agents
  // tend to just create_task for themselves instead of doing the work.
  // Each file entry must provide exactly one of `url` (http/https) or
  // `path` (absolute path under /tmp/).
  | {
      type: "share_files";
      conversation_id: string;
      body_md?: string;
      reply_to?: string;
      files: Array<{ url?: string; path?: string; name?: string }>;
    }
  // Same as share_files but posts as a task_comment on a task board card.
  // Lets agents work on tasks during heartbeats — drop a progress note
  // plus whatever artifacts they produced. Attachments show up in the
  // comment AND in the workspace Files tab.
  | {
      type: "share_to_task";
      task_id: string;
      body_md?: string;
      files: Array<{ url?: string; path?: string; name?: string }>;
    };

export interface ExecOutcome {
  actionsApplied: number;
  errors: string[];
  trace: string[];
}

// ───────────────── scope enforcement ─────────────────
// Each action type maps to the scope an agent must hold to perform it without
// approval. The vocabulary matches the docs + install defaults
// (channels.read / channels.reply) and extends naturally to tasks.* and the
// agent meta-actions. Actions absent from this map (e.g. set_memory, call_tool,
// request_approval) are always allowed — they're either internal bookkeeping
// or are themselves the approval mechanism.
const ACTION_SCOPE: Partial<Record<AgentAction["type"], string>> = {
  post_message: "channels.reply",
  open_thread: "channels.reply",
  share_files: "channels.reply",
  react: "channels.reply",
  create_task: "tasks.write",
  update_task: "tasks.write",
  assign_task: "tasks.write",
  task_comment: "tasks.write",
  share_to_task: "tasks.write",
  create_goal: "tasks.write",
  decompose_goal: "tasks.write",
  ledger_update: "tasks.write",
};

// Risk level per action, used by the opt-in risk gate (APPROVE_RISK_AT). The
// idea mirrors PraisonAI's @require_approval risk levels: even an in-scope
// action can be routed to a human when it's high-risk. Unmapped → "low".
type Risk = "low" | "medium" | "high";
const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const ACTION_RISK: Partial<Record<AgentAction["type"], Risk>> = {
  share_files: "high", // fetches arbitrary external URLs and posts files
  share_to_task: "medium",
  delete_memory: "medium",
  assign_task: "medium",
  decompose_goal: "medium", // fans a goal out into many tasks + assignments
};

// Scopes an agent with an EMPTY scope list is treated as holding. Empty no
// longer means "unrestricted" (the old advisory behavior) — it falls back to a
// safe read/reply baseline. A genuinely unrestricted agent must opt in with a
// "*" wildcard scope. This is the secure-by-default posture.
const SAFE_DEFAULT_SCOPES = ["channels.read", "channels.reply"];

// Scope enforcement is ON by default. Operators can disable it for a trusted
// single-tenant deployment by setting ENFORCE_AGENT_SCOPES to a falsey value
// (0 / false / no / off). When on, an action whose required scope is absent is
// converted into an approval card instead of executing; the human approves or
// denies it from the approvals UI.
function scopeEnforcementOn(): boolean {
  const v = (process.env.ENFORCE_AGENT_SCOPES ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

// Optional risk gate: when APPROVE_RISK_AT is set to a level, any action at or
// above that risk requires approval even if it's within scope. Unset = off, so
// it never disrupts an existing deployment until an operator opts in.
function riskGateLevel(): Risk | null {
  const v = (process.env.APPROVE_RISK_AT ?? "").trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : null;
}

function actionAllowedByScopes(actionType: AgentAction["type"], scopes: string[]): boolean {
  const effective = !scopes || scopes.length === 0 ? SAFE_DEFAULT_SCOPES : scopes;
  if (effective.includes("*")) return true; // explicit opt-in to unrestricted
  const required = ACTION_SCOPE[actionType];
  if (!required) return true; // unmapped actions (set_memory, call_tool, …) are always allowed
  return effective.includes(required);
}

// True if the action's risk is at or above the configured gate threshold.
function actionGatedByRisk(actionType: AgentAction["type"]): boolean {
  const threshold = riskGateLevel();
  if (!threshold) return false;
  const risk: Risk = ACTION_RISK[actionType] ?? "low";
  return RISK_ORDER[risk] >= RISK_ORDER[threshold];
}

// Pull a short, human-readable summary + the gating conversation id out of an
// action, used to populate the approval card when an action is gated.
function describeForApproval(a: AgentAction): { action: string; conversationId: string | null; payload: Record<string, unknown> } {
  switch (a.type) {
    case "post_message":
    case "share_files":
      return { action: `${a.type} in ${a.conversation_id}`, conversationId: a.conversation_id, payload: { ...a } };
    case "open_thread":
      return { action: `open_thread on ${a.message_id}`, conversationId: null, payload: { ...a } };
    case "react":
      return { action: `react ${a.emoji}`, conversationId: null, payload: { ...a } };
    case "create_task":
      return { action: `create_task "${a.title}"`, conversationId: a.conversation_id ?? null, payload: { ...a } };
    case "update_task":
      return { action: `update_task ${a.task_id}`, conversationId: null, payload: { ...a } };
    case "assign_task":
      return { action: `assign_task ${a.task_id}`, conversationId: null, payload: { ...a } };
    case "create_goal":
      return { action: `create_goal "${a.title}"`, conversationId: null, payload: { ...a } };
    case "decompose_goal":
      return { action: `decompose_goal ${a.goal_id}`, conversationId: null, payload: { ...a } };
    case "task_comment":
    case "share_to_task":
      return { action: `${a.type} on ${a.task_id}`, conversationId: null, payload: { ...a } };
    default:
      return { action: a.type, conversationId: null, payload: {} };
  }
}

// Approval dedupe. Exact agent+scope+action matching got beaten in the wild:
// agents minted a fresh free-form scope string every wake (github_auth,
// hosting, hosting_credentials, deploy, deploy_creds, github_token, …) for
// the SAME credential ask, so 11 cards piled up for one human decision. Match
// on trigram similarity of the action text instead — workspace-wide, so three
// agents asking for the same thing share one card — and remember DENIALS: a
// similar request a human denied in the last 7 days is refused outright (a
// denial is an answer, not a retry timer).
const DENIAL_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
// An agent's own re-ask matches looser than a teammate's distinct request.
const DUP_SIM_SELF = 0.45;
const DUP_SIM_TEAMMATE = 0.62;

type DuplicateApproval = {
  id: string;
  status: string;
  agentId: string;
  decidedAt: Date | null;
  action: string;
};

async function findDuplicateApproval(
  agentId: string,
  action: string,
): Promise<DuplicateApproval | null> {
  const [me] = await db
    .select({ workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!me) return null;
  const deniedCutoff = new Date(Date.now() - DENIAL_MEMORY_MS);
  const rows = await db
    .select({
      id: approvals.id,
      status: approvals.status,
      agentId: approvals.agentId,
      decidedAt: approvals.decidedAt,
      action: approvals.action,
      sim: sql<number>`similarity(${approvals.action}, ${action})`.as("sim"),
    })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(
      and(
        eq(agents.workspaceId, me.workspaceId),
        or(
          eq(approvals.status, "pending"),
          and(eq(approvals.status, "denied"), gt(approvals.decidedAt, deniedCutoff)),
        ),
        sql`similarity(${approvals.action}, ${action}) > ${DUP_SIM_SELF}`,
      ),
    )
    .orderBy(sql`similarity(${approvals.action}, ${action}) desc`)
    .limit(5);
  for (const r of rows) {
    const threshold = r.agentId === agentId ? DUP_SIM_SELF : DUP_SIM_TEAMMATE;
    if (Number(r.sim) >= threshold) return r;
  }
  return null;
}

// Actionable rejection copy for a duplicate/denied approval match. Returned as
// an executor error so the agent reads WHY it was dropped and what to do.
function duplicateApprovalError(actionType: string, dup: DuplicateApproval, agentId: string): string {
  if (dup.status === "denied") {
    const when = dup.decidedAt ? dup.decidedAt.toISOString().slice(0, 10) : "recently";
    return (
      `${actionType} refused: a human DENIED an equivalent request (${dup.id}, "${dup.action}") on ${when}. ` +
      `A denial is final — do NOT re-request or rephrase it. Set the dependent task status:"blocked" with one comment, or pursue an approach that doesn't need this approval.`
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

// Credential-/access-begging or bare "still blocked" restatement. Used to stop
// agents re-posting the same blocker on an already-blocked task every wake.
// Narrow: needs a blocked/blocker/waiting cue OR an explicit credential ask, so
// a genuine progress comment isn't caught.
const BLOCKER_RESTATEMENT_RE =
  /\b(?:still\s+blocked|i'?m\s+blocked|remain(?:s|ing)?\s+blocked|blocked\s*[:\-]|need\s+(?:the\s+)?(?:site\s+)?(?:access\s+)?credentials?|need\s+(?:access|a\s+token|the\s+token|api\s+(?:key|token)|a\s+(?:github|netlify|vercel)\b)|provide\s+(?:the\s+)?(?:credentials?|access|a\s+token|github\s+pat|netlify\s+token)|waiting\s+(?:for|on)\s+(?:credentials?|access|approval|the\s+token)|awaiting\s+(?:credentials?|access|approval))\b/i;

// Near-synonyms agents emit for canonical action types. Mirror of the bridge's
// ACTION_ALIASES — keep both in sync. Without normalization these paraphrases
// hit the `default: unknown_action` case and the agent's intent is lost.
const ACTION_ALIASES: Record<string, string> = {
  comment_on_task: "task_comment",
  add_comment: "task_comment",
  comment: "task_comment",
  set_goal: "create_goal",
  plan_goal: "decompose_goal",
};

// Required-field shape check per action type. Deliberately PRESENCE-only (it
// doesn't reject unknown extra fields) so a valid action with stray keys still
// runs — the goal is to catch the malformed/empty actions that silently no-op,
// not to be a strict schema. Each rule names the missing field and the fix, and
// that string is fed straight back to the agent on its next turn.
const REQUIRED_STRING_FIELDS: Record<string, string[]> = {
  post_message: ["conversation_id", "body_md"],
  react: ["message_id", "emoji"],
  open_thread: ["message_id", "body_md"],
  request_approval: ["scope", "action"],
  set_memory: ["key"],
  delete_memory: ["key"],
  memory_append: ["label", "text"],
  memory_rethink: ["label", "value"],
  call_tool: ["name"],
  create_task: ["title"],
  update_task: ["task_id"],
  assign_task: ["task_id", "member_id"],
  create_goal: ["title"],
  decompose_goal: ["goal_id"],
  ledger_update: ["goal_id"],
  task_comment: ["task_id", "body_md"],
  share_files: ["conversation_id"],
  share_to_task: ["task_id"],
};

export function validateActionShape(a: AgentAction): string | null {
  const type = (a as { type?: unknown }).type;
  if (typeof type !== "string" || !type) return "action skipped: missing \"type\".";
  const rec = a as unknown as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS[type] ?? []) {
    const v = rec[field];
    if (typeof v !== "string" || !v.trim()) {
      return (
        `${type} skipped: missing required field "${field}". ` +
        `Emit it as a complete action, e.g. include a valid "${field}" (use an exact id from the context above, not a guess).`
      );
    }
  }
  // Actions that carry files need a non-empty files array, or they no-op.
  if (type === "share_files" || type === "share_to_task") {
    const files = rec["files"];
    if (!Array.isArray(files) || files.length === 0) {
      return `${type} skipped: "files" must be a non-empty array of {path|url}. Attach the /workspace file you actually wrote (run \`ls -R /workspace\` to get the exact path).`;
    }
  }
  // ledger_update needs at least one payload field or it does nothing.
  if (type === "ledger_update") {
    const hasFacts = Array.isArray(rec["facts"]) && (rec["facts"] as unknown[]).length > 0;
    if (!hasFacts && !rec["progress_note"] && !rec["dead_end"]) {
      return `ledger_update skipped: provide at least one of "facts", "progress_note", or "dead_end".`;
    }
  }
  return null;
}

export async function applyActions(params: {
  agentId: string;
  runId: string;
  actions: AgentAction[];
}): Promise<ExecOutcome> {
  const { agentId, runId } = params;
  const out: ExecOutcome = { actionsApplied: 0, errors: [], trace: [] };

  const [agentMember] = await db
    .select()
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, agentId)))
    .limit(1);
  if (!agentMember) {
    out.errors.push("agent_member_missing");
    return out;
  }

  // Load the agent's scopes once for the run when either gate is active.
  const enforce = scopeEnforcementOn();
  const riskGate = riskGateLevel() !== null;
  let scopes: string[] = [];
  if (enforce) {
    const [agentRow] = await db
      .select({ scopes: agents.scopes })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    scopes = agentRow?.scopes ?? [];
  }

  for (const a of params.actions) {
    // Server-side belt for action-name paraphrases. The bridge normalizes
    // synonyms (comment_on_task → task_comment, etc.) before actions reach
    // here, but actions can arrive from other callers too; normalize again so
    // a near-synonym never falls through to `unknown_action` and silently
    // strands a task card. Keep this in sync with the bridge's ACTION_ALIASES.
    if (a && typeof (a as { type?: unknown }).type === "string") {
      (a as { type: string }).type =
        ACTION_ALIASES[(a as { type: string }).type] ?? (a as { type: string }).type;
    }
    // Structured validation: the action path is text-scraped, so a malformed
    // action (missing task_id, empty body, no files) used to silently no-op or
    // throw a generic error — a big source of "applied:0" runs. Validate the
    // required shape up front and feed a SPECIFIC, actionable error back to the
    // agent instead. This is the schema-validation half of native tool-calling,
    // applied to the path that's actually wired. Keeps the executor's scope /
    // risk / approval gating intact (which a raw MCP→REST path would bypass).
    const shapeError = validateActionShape(a);
    if (shapeError) {
      out.errors.push(shapeError);
      continue;
    }
    try {
      // Gate an action when it's out of scope (enforcement on) OR at/above the
      // configured risk threshold (risk gate on). Either way it becomes an
      // approval card instead of executing; the human approves/denies it from
      // the approvals UI. The payload is preserved for replay-on-approval.
      const outOfScope = enforce && !actionAllowedByScopes(a.type, scopes);
      const riskGated = riskGate && actionGatedByRisk(a.type);
      if (outOfScope || riskGated) {
        const d = describeForApproval(a);
        const reason = outOfScope ? (ACTION_SCOPE[a.type] ?? a.type) : `risk:${ACTION_RISK[a.type] ?? "low"}`;
        // A matching APPROVED approval is a one-shot pass: the human already
        // said yes to exactly this action, so execute it now and consume the
        // approval (status → applied) so it can't authorize a second replay.
        // Without this, the re-emitted action just gated again into a fresh
        // card and "approve" never actually let anything through.
        const [granted] = await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.agentId, agentId),
              eq(approvals.status, "approved"),
              eq(approvals.scope, reason),
              eq(approvals.action, d.action),
            ),
          )
          .limit(1);
        if (granted) {
          await db
            .update(approvals)
            .set({ status: "applied" })
            .where(eq(approvals.id, granted.id));
          out.trace.push(`gated ${a.type} allowed by approval ${granted.id} (consumed)`);
          await applyOne(agentId, runId, agentMember.id, a, out);
          out.actionsApplied++;
          continue;
        }
        const dup = await findDuplicateApproval(agentId, d.action);
        if (dup) {
          out.trace.push(`gated ${a.type} → ${dup.status} duplicate approval ${dup.id}, skipped`);
          out.errors.push(duplicateApprovalError(a.type, dup, agentId));
          continue;
        }
        const apId = id("ap");
        await db.insert(approvals).values({
          id: apId,
          agentRunId: runId,
          agentId,
          conversationId: d.conversationId,
          scope: reason,
          action: d.action,
          payloadJson: d.payload,
          status: "pending",
        });
        if (d.conversationId) {
          await publishToConversation(d.conversationId, {
            type: "approval.new",
            approvalId: apId,
            agentId,
            scope: reason,
            action: d.action,
            conversationId: d.conversationId,
          });
        }
        const why = outOfScope ? `requires scope "${reason}"` : `is ${reason} and needs approval`;
        out.trace.push(`gated ${a.type} → approval ${apId} (${why})`);
        out.errors.push(`${a.type} ${why} — opened approval ${apId}`);
        continue;
      }
      await applyOne(agentId, runId, agentMember.id, a, out);
      out.actionsApplied++;
    } catch (e) {
      out.errors.push(`${a.type}: ${(e as Error).message}`);
    }
  }
  return out;
}

async function applyOne(
  agentId: string,
  runId: string,
  agentMemberId: string,
  a: AgentAction,
  out: ExecOutcome,
): Promise<void> {
  switch (a.type) {
    case "post_message": {
      const hasAttachments = Array.isArray(a.attachments) && a.attachments.length > 0;
      const guard = checkReplyBody(a.body_md, { hasAttachments });
      if (!guard.ok) {
        out.trace.push(`post_message rejected (${guard.reason})`);
        out.errors.push(
          `post_message rejected: ${guard.reason}.${guardRejectHint(guard.reason)}`,
        );
        return;
      }
      const dup = await checkRecentDuplicate(a.conversation_id, guard.bodyMd);
      if (!dup.ok) {
        out.trace.push(
          `post_message rejected (duplicate_of_recent vs ${dup.againstId} @${dup.score})`,
        );
        out.errors.push("post_message rejected: duplicate_of_recent");
        return;
      }

      const [mm] = await db
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, a.conversation_id),
            eq(conversationMembers.memberId, agentMemberId),
          ),
        )
        .limit(1);
      if (!mm) throw new Error("agent_not_in_conversation");

      // Resolve mentions so agent→agent @-mentions wake the tagged agent
      // and so the sidebar's unread-mention count is correct.
      const [authorRow] = await db
        .select({ workspaceId: members.workspaceId })
        .from(members)
        .where(eq(members.id, agentMemberId))
        .limit(1);
      const workspaceId = authorRow?.workspaceId ?? "";
      const handles = extractMentionHandles(guard.bodyMd);
      const isBroadcast = handles.some(
        (h) => h === "everyone" || h === "channel",
      );
      const directMentionIds = workspaceId
        ? await resolveHandlesToMemberIds(handles, workspaceId)
        : [];
      let broadcastIds: string[] = [];
      if (isBroadcast) {
        const all = await db
          .select({ memberId: conversationMembers.memberId })
          .from(conversationMembers)
          .where(eq(conversationMembers.conversationId, a.conversation_id));
        broadcastIds = all
          .map((r) => r.memberId)
          .filter((m) => m !== agentMemberId);
      }
      const resolvedMentionIds = Array.from(
        new Set([...directMentionIds, ...broadcastIds]),
      );

      const mid = id("m");
      const now = new Date();
      const safeAttachments = sanitizeAttachments(a.attachments);
      await db.insert(messages).values({
        id: mid,
        conversationId: a.conversation_id,
        memberId: agentMemberId,
        parentId: a.reply_to ?? null,
        bodyMd: guard.bodyMd,
        attachmentsJson: safeAttachments,
        mentions: resolvedMentionIds,
        ts: now,
      });
      const payload = {
        id: mid,
        conversationId: a.conversation_id,
        memberId: agentMemberId,
        parentId: a.reply_to ?? null,
        bodyMd: guard.bodyMd,
        attachmentsJson: safeAttachments,
        mentions: resolvedMentionIds,
        ts: now.toISOString(),
        reactions: [],
        replyCount: 0,
      };
      await publishToConversation(a.conversation_id, {
        type: "message.new",
        conversationId: a.conversation_id,
        message: payload,
      });
      if (workspaceId) {
        fireMentionTriggers({
          authorMemberId: agentMemberId,
          conversationId: a.conversation_id,
          messageId: mid,
          bodyMd: guard.bodyMd,
          parentId: a.reply_to ?? null,
          workspaceId,
          resolvedMentionIds,
          directMentionIds,
          isBroadcast,
        }).catch(() => {
          // trigger dispatch is fire-and-forget — the post itself landed
        });
        // Inbox notifications for human recipients (agent DM'd a user, or
        // @-mentioned one). Mirrors the human post path. Fire-and-forget.
        notifyForMessage({
          workspaceId,
          conversationId: a.conversation_id,
          messageId: mid,
          authorMemberId: agentMemberId,
          bodyMd: guard.bodyMd,
          directMentionIds,
          isDm: await isDmConversation(a.conversation_id),
        }).catch(() => {});
      }
      out.trace.push(`post_message ${mid} in ${a.conversation_id}`);
      return;
    }
    case "react": {
      const [m] = await db.select().from(messages).where(eq(messages.id, a.message_id)).limit(1);
      if (!m) throw new Error("message_not_found");
      await db
        .insert(reactions)
        .values({ messageId: a.message_id, memberId: agentMemberId, emoji: a.emoji })
        .onConflictDoNothing();
      await publishToConversation(m.conversationId, {
        type: "reaction.toggled",
        conversationId: m.conversationId,
        messageId: a.message_id,
        memberId: agentMemberId,
        emoji: a.emoji,
        added: true,
      });
      out.trace.push(`react ${a.emoji} on ${a.message_id}`);
      return;
    }
    case "open_thread": {
      const guard = checkReplyBody(a.body_md);
      if (!guard.ok) {
        out.trace.push(`open_thread rejected (${guard.reason})`);
        out.errors.push(`open_thread rejected: ${guard.reason}`);
        return;
      }
      const [m] = await db.select().from(messages).where(eq(messages.id, a.message_id)).limit(1);
      if (!m) throw new Error("message_not_found");
      const dup = await checkRecentDuplicate(m.conversationId, guard.bodyMd);
      if (!dup.ok) {
        out.trace.push(
          `open_thread rejected (duplicate_of_recent vs ${dup.againstId} @${dup.score})`,
        );
        out.errors.push("open_thread rejected: duplicate_of_recent");
        return;
      }
      const [authorRow] = await db
        .select({ workspaceId: members.workspaceId })
        .from(members)
        .where(eq(members.id, agentMemberId))
        .limit(1);
      const workspaceId = authorRow?.workspaceId ?? "";
      const handles = extractMentionHandles(guard.bodyMd);
      const isBroadcast = handles.some(
        (h) => h === "everyone" || h === "channel",
      );
      const directMentionIds = workspaceId
        ? await resolveHandlesToMemberIds(handles, workspaceId)
        : [];
      const resolvedMentionIds = directMentionIds;
      const mid = id("m");
      const now = new Date();
      await db.insert(messages).values({
        id: mid,
        conversationId: m.conversationId,
        memberId: agentMemberId,
        parentId: a.message_id,
        bodyMd: guard.bodyMd,
        attachmentsJson: [],
        mentions: resolvedMentionIds,
        ts: now,
      });
      if (workspaceId) {
        fireMentionTriggers({
          authorMemberId: agentMemberId,
          conversationId: m.conversationId,
          messageId: mid,
          bodyMd: guard.bodyMd,
          parentId: a.message_id,
          workspaceId,
          resolvedMentionIds,
          directMentionIds,
          isBroadcast,
        }).catch(() => {});
      }
      await publishToConversation(m.conversationId, {
        type: "message.new",
        conversationId: m.conversationId,
        message: {
          id: mid,
          conversationId: m.conversationId,
          memberId: agentMemberId,
          parentId: a.message_id,
          bodyMd: guard.bodyMd,
          attachmentsJson: [],
          mentions: resolvedMentionIds,
          ts: now.toISOString(),
          reactions: [],
          replyCount: 0,
        },
      });
      out.trace.push(`open_thread ${mid}`);
      return;
    }
    case "request_approval": {
      const dup = await findDuplicateApproval(agentId, a.action);
      if (dup) {
        out.trace.push(`request_approval → ${dup.status} duplicate ${dup.id}, skipped`);
        out.errors.push(duplicateApprovalError("request_approval", dup, agentId));
        return;
      }
      const apId = id("ap");
      await db.insert(approvals).values({
        id: apId,
        agentRunId: runId,
        agentId,
        conversationId: a.conversation_id ?? null,
        scope: a.scope,
        action: a.action,
        payloadJson: a.payload ?? {},
        status: "pending",
      });
      if (a.conversation_id) {
        await publishToConversation(a.conversation_id, {
          type: "approval.new",
          approvalId: apId,
          agentId,
          scope: a.scope,
          action: a.action,
          conversationId: a.conversation_id,
        });
      }
      out.trace.push(`request_approval ${apId}`);
      return;
    }
    case "set_memory": {
      const scope = a.scope ?? "global";
      const scopeId = scope === "global" ? "" : (a.scope_id ?? "").trim();
      if (scope !== "global" && !scopeId) {
        out.errors.push(`set_memory: scope_id required for scope=${scope}`);
        return;
      }
      await db
        .insert(memoryKv)
        .values({ agentId, scope, scopeId, key: a.key, valueJson: a.value as never })
        .onConflictDoUpdate({
          target: [memoryKv.agentId, memoryKv.scope, memoryKv.scopeId, memoryKv.key],
          set: { valueJson: a.value as never, updatedAt: new Date() },
        });
      out.trace.push(
        `set_memory ${scope === "global" ? "" : `${scope}:${scopeId} `}${a.key}`,
      );
      return;
    }
    case "delete_memory": {
      const scope = a.scope ?? "global";
      const scopeId = scope === "global" ? "" : (a.scope_id ?? "").trim();
      if (scope !== "global" && !scopeId) {
        out.errors.push(`delete_memory: scope_id required for scope=${scope}`);
        return;
      }
      await db
        .delete(memoryKv)
        .where(
          and(
            eq(memoryKv.agentId, agentId),
            eq(memoryKv.scope, scope),
            eq(memoryKv.scopeId, scopeId),
            eq(memoryKv.key, a.key),
          ),
        );
      out.trace.push(
        `delete_memory ${scope === "global" ? "" : `${scope}:${scopeId} `}${a.key}`,
      );
      return;
    }
    case "call_tool": {
      // The platform doesn't execute tools — the agent runtime does. We just record it.
      out.trace.push(`tool ${a.name}`);
      return;
    }
    case "memory_append":
    case "memory_rethink": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      const edit =
        a.type === "memory_append"
          ? ({ op: "append", text: a.text } as const)
          : ({ op: "rethink", value: a.value } as const);
      const err = await editAgentBlock(agentId, ws, agentMemberId, a.label, edit);
      if (err) {
        out.errors.push(`${a.type}: ${err}`);
        return;
      }
      out.trace.push(`${a.type} ${a.label}`);
      return;
    }
    case "create_task": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");

      // Cross-heartbeat dedup: refuse to create a task whose title closely
      // matches one we created in the last 24h. Agents heartbeating into
      // quiet periods kept spawning the same "draft voiceover script" /
      // "provision DNS" task over and over because they had no way to know
      // it already existed.
      const dup = await db
        .select({ id: tasks.id, title: tasks.title, status: tasks.status })
        .from(tasks)
        .where(
          and(
            eq(tasks.workspaceId, ws),
            gt(tasks.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
            sql`similarity(${tasks.title}, ${a.title}) > 0.7`,
          ),
        )
        .orderBy(sql`similarity(${tasks.title}, ${a.title}) desc`)
        .limit(1);
      if (dup.length > 0) {
        out.errors.push(
          `create_task blocked: near-duplicate of ${dup[0].id} ("${dup[0].title}", status=${dup[0].status}) created in the last 24h. Update or comment on that task instead.`,
        );
        out.trace.push(`create_task_dedupe ${dup[0].id}`);
        return;
      }

      const r = await createTask(
        {
          title: a.title,
          bodyMd: a.body_md,
          status: a.status,
          parentId: a.parent_id,
          goalId: a.goal_id,
          conversationId: a.conversation_id ?? null,
          assignees: a.assignees,
          labels: a.labels,
          dueAt: a.due_at,
        },
        agentMemberId,
        ws,
      );
      if ("error" in r) {
        out.errors.push(`create_task: ${r.error}`);
        return;
      }
      out.trace.push(`create_task ${r.task.id}`);
      return;
    }
    case "update_task": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      const r = await updateTask(
        a.task_id,
        {
          title: a.title,
          bodyMd: a.body_md,
          status: a.status,
          progress: a.progress,
          dueAt: a.due_at ?? undefined,
          archived: a.archived,
        },
        agentMemberId,
        ws,
      );
      if ("error" in r) {
        if (r.error === "done_requires_review") {
          out.errors.push(
            `update_task: done_requires_review — you're an assignee on ${a.task_id}, and the maker can't mark their own work done. Attach your deliverable (share_to_task) and set status:"review" instead; your manager or a human verifies and flips it to done.`,
          );
        } else if (r.error === "done_requires_evidence") {
          out.errors.push(
            `update_task: done_requires_evidence — ${a.task_id} has no substantive deliverable attached. share_to_task the actual artifact first, or leave it in "review" for a human.`,
          );
        } else if (r.error === "verification_failed") {
          const why = await latestVerificationRationale(a.task_id).catch(() => null);
          out.errors.push(
            `update_task: verification_failed — the deliverable on ${a.task_id} did NOT pass the quality check${why ? `: ${why}` : "."} ` +
              `Don't flip it to done. Comment what's missing and send it back so the maker fixes the actual artifact, then re-review.`,
          );
        } else {
          out.errors.push(`update_task: ${r.error}`);
        }
        return;
      }
      out.trace.push(`update_task ${a.task_id}`);
      return;
    }
    case "assign_task": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      const r = await addAssignee(a.task_id, a.member_id, agentMemberId, ws);
      if ("error" in r) {
        out.errors.push(`assign_task: ${r.error}`);
        return;
      }
      out.trace.push(`assign_task ${a.task_id}→${a.member_id}`);
      return;
    }
    case "create_goal": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      const r = await createGoal(
        { title: a.title, bodyMd: a.body_md, parentGoalId: a.parent_goal_id, kind: a.kind },
        agentMemberId,
        ws,
      );
      if ("error" in r) {
        out.errors.push(`create_goal: ${r.error}`);
        return;
      }
      out.trace.push(`create_goal ${r.goal.id}`);
      return;
    }
    case "decompose_goal": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      const r = await planGoal({ goalId: a.goal_id, workspaceId: ws, actorMemberId: agentMemberId });
      if ("error" in r) {
        out.errors.push(`decompose_goal: ${r.error}`);
        return;
      }
      out.trace.push(
        `decompose_goal ${a.goal_id} → ${r.plan.taskCount} task(s), ${r.plan.rootCount} started`,
      );
      return;
    }
    case "ledger_update": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      const led = await loadLedger(a.goal_id);
      if (!led || led.workspaceId !== ws) {
        out.errors.push(`ledger_update: goal ${a.goal_id} has no ledger in this workspace.`);
        return;
      }
      let n = 0;
      for (const f of a.facts ?? []) {
        if (typeof f === "string" && f.trim()) {
          await appendFact(a.goal_id, f);
          n++;
        }
      }
      if (a.progress_note && a.progress_note.trim()) {
        await appendProgressNote(a.goal_id, agentMemberId, a.progress_note);
        n++;
      }
      if (a.dead_end && a.dead_end.trim()) {
        await appendDeadEnd(a.goal_id, a.dead_end);
        n++;
      }
      out.trace.push(`ledger_update ${a.goal_id} (+${n})`);
      return;
    }
    case "task_comment": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      const hasAttachments = Array.isArray(a.attachments) && a.attachments.length > 0;
      const guard = checkReplyBody(a.body_md, { hasAttachments });
      if (!guard.ok) {
        out.errors.push(
          `task_comment rejected: ${guard.reason}.${guardRejectHint(guard.reason)}`,
        );
        return;
      }
      // BLOCKED PROTOCOL enforcement: re-stating a blocker (esp. begging for
      // credentials/access) on a task that's ALREADY blocked is noise, not
      // progress — it was the dominant failure mode (hourly "still need creds"
      // comments). The prompt forbids it; enforce it server-side. Only gate
      // bare restatements with no attachment — a real update (a file shipped,
      // the blocker cleared) still gets through.
      if (!hasAttachments && BLOCKER_RESTATEMENT_RE.test(guard.bodyMd)) {
        const target = await loadTask(a.task_id);
        if (target && target.status === "blocked") {
          out.errors.push(
            `task_comment skipped: ${a.task_id} is already status="blocked" and your comment just re-states the blocker. Per the BLOCKED PROTOCOL, say it ONCE then stop — a blocked task is off your rotation until something actually changes (a human replies, an approval is decided). Do NOT re-ask. Pick up different work.`,
          );
          return;
        }
      }
      // Comment-level dedupe: a near-identical restatement of a recent comment
      // on the same task is the relocated begging loop — drop it with a hint.
      const cdup = await checkRecentDuplicateTaskComment(a.task_id, guard.bodyMd);
      if (!cdup.ok) {
        out.errors.push(
          `task_comment skipped: near-duplicate of an existing comment on ${a.task_id} (vs ${cdup.againstId}). You already said this — don't repeat it. Either do the next concrete step (ship a file via share_to_task, change status) or stay silent.`,
        );
        return;
      }
      const safeAttachments = sanitizeAttachments(a.attachments);
      const r = await addComment(
        a.task_id,
        guard.bodyMd,
        Array.isArray(a.mentions) ? a.mentions : [],
        agentMemberId,
        ws,
        safeAttachments,
      );
      if ("error" in r) {
        out.errors.push(`task_comment: ${r.error}`);
        return;
      }
      out.trace.push(`task_comment on ${a.task_id}${safeAttachments.length ? ` (${safeAttachments.length} file${safeAttachments.length === 1 ? "" : "s"})` : ""}`);
      return;
    }
    case "share_to_task": {
      // Mirror of share_files but targets a task card. The file-fetching
      // helper runs URL fetches / /tmp reads and uploads to storage; we
      // then thread the attachments through addComment() so they show up
      // both on the task and in the workspace Files tab.
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      // Validate the task exists in this workspace BEFORE uploading anything.
      // Otherwise a wrong/hallucinated task_id leaves the file in storage as
      // an orphan and the agent's "I shipped X" claim silently disappears.
      const targetTask = await loadTask(a.task_id);
      if (!targetTask) {
        out.errors.push(
          `share_to_task: task_id ${a.task_id} not found. Check the MY TASKS block — use one of those exact ids, not a guess.`,
        );
        return;
      }
      if (targetTask.workspaceId !== ws) {
        out.errors.push(`share_to_task: task ${a.task_id} is in a different workspace.`);
        return;
      }
      const rawBody = typeof a.body_md === "string" ? a.body_md : "";
      const guard = checkReplyBody(rawBody || "(attachments)");
      const bodyMd = guard.ok ? guard.bodyMd : rawBody;
      const files = Array.isArray(a.files) ? a.files : [];
      const { attachments: fetched, skips } = await fetchAgentAttachments(files, out.trace, "share_to_task");
      if (fetched.length === 0) {
        const why = skips.length ? ` (${skips.join("; ")})` : "";
        out.errors.push(
          `share_to_task: no files fetched from ${files.length} source(s)${why}. ` +
            `Run \`ls -R /workspace\` to find the exact path you actually wrote, then share that — a path that doesn't exist won't attach.`,
        );
        return;
      }
      const r = await addComment(
        a.task_id,
        bodyMd || `📎 attached ${fetched.length} file${fetched.length === 1 ? "" : "s"}`,
        [],
        agentMemberId,
        ws,
        fetched,
      );
      if ("error" in r) {
        out.errors.push(`share_to_task: ${r.error}`);
        return;
      }
      // Persist each shared file as a durable, versioned task_artifact — the
      // source of truth for "what was delivered". The comment attachment above
      // is kept for the activity feed (back-compat); this is the queryable
      // store. Best-effort: a failed artifact write logs a trace line but
      // doesn't fail the share (the comment already landed).
      let artifactsSaved = 0;
      for (const f of fetched) {
        try {
          const buf = await readObject(f.key);
          if (!buf) {
            out.trace.push(`share_to_task artifact skip ${f.name}: bytes not found`);
            continue;
          }
          // Don't persist placeholder stubs as durable deliverables (they'd
          // litter the task's artifacts list); the comment attachment above
          // still landed for the activity feed.
          if (!isSubstantiveContent(buf, f.contentType, f.name, targetTask.title)) {
            out.trace.push(`share_to_task artifact skip ${f.name}: looks like a placeholder, not stored as a deliverable`);
            continue;
          }
          await createArtifact({
            taskId: a.task_id,
            workspaceId: ws,
            name: f.name,
            buffer: buf,
            contentType: f.contentType,
            createdBy: agentMemberId,
          });
          artifactsSaved++;
        } catch (e) {
          out.trace.push(`share_to_task artifact ${f.name} failed: ${(e as Error).message}`);
        }
      }
      out.trace.push(
        `share_to_task on ${a.task_id} (${fetched.length} file${fetched.length === 1 ? "" : "s"}, ${artifactsSaved} artifact${artifactsSaved === 1 ? "" : "s"})`,
      );
      return;
    }
    case "share_files": {
      const guard = checkReplyBody(a.body_md ?? "");
      // An empty body is allowed for share_files — the attachments carry the message.
      const bodyMd = guard.ok ? guard.bodyMd : "";

      const [mm] = await db
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, a.conversation_id),
            eq(conversationMembers.memberId, agentMemberId),
          ),
        )
        .limit(1);
      if (!mm) throw new Error("agent_not_in_conversation");

      const files = Array.isArray(a.files) ? a.files : [];
      const { attachments: fetched, skips } = await fetchAgentAttachments(files, out.trace, "share_files");

      if (fetched.length === 0) {
        const why = skips.length ? ` (${skips.join("; ")})` : "";
        out.errors.push(
          `share_files: no files fetched from ${files.length} source(s)${why}. ` +
            `Check the path/url actually exists — a /workspace path you didn't write won't attach.`,
        );
        return;
      }

      // Post a message carrying the attachments — mirror post_message's flow
      // for mention-resolution + broadcast expansion + trigger firing.
      const [authorRow] = await db
        .select({ workspaceId: members.workspaceId })
        .from(members)
        .where(eq(members.id, agentMemberId))
        .limit(1);
      const workspaceId = authorRow?.workspaceId ?? "";
      const handles = extractMentionHandles(bodyMd);
      const isBroadcast = handles.some((h) => h === "everyone" || h === "channel");
      const directMentionIds = workspaceId
        ? await resolveHandlesToMemberIds(handles, workspaceId)
        : [];
      let broadcastIds: string[] = [];
      if (isBroadcast) {
        const all = await db
          .select({ memberId: conversationMembers.memberId })
          .from(conversationMembers)
          .where(eq(conversationMembers.conversationId, a.conversation_id));
        broadcastIds = all.map((r) => r.memberId).filter((m) => m !== agentMemberId);
      }
      const resolvedMentionIds = Array.from(new Set([...directMentionIds, ...broadcastIds]));
      const mid = id("m");
      const now = new Date();
      await db.insert(messages).values({
        id: mid,
        conversationId: a.conversation_id,
        memberId: agentMemberId,
        parentId: a.reply_to ?? null,
        bodyMd,
        attachmentsJson: fetched,
        mentions: resolvedMentionIds,
        ts: now,
      });
      await publishToConversation(a.conversation_id, {
        type: "message.new",
        conversationId: a.conversation_id,
        message: {
          id: mid,
          conversationId: a.conversation_id,
          memberId: agentMemberId,
          parentId: a.reply_to ?? null,
          bodyMd,
          attachmentsJson: fetched,
          mentions: resolvedMentionIds,
          ts: now.toISOString(),
          reactions: [],
          replyCount: 0,
        },
      });
      if (workspaceId) {
        fireMentionTriggers({
          authorMemberId: agentMemberId,
          conversationId: a.conversation_id,
          messageId: mid,
          bodyMd,
          parentId: a.reply_to ?? null,
          workspaceId,
          resolvedMentionIds,
          directMentionIds,
          isBroadcast,
        }).catch(() => {});
        notifyForMessage({
          workspaceId,
          conversationId: a.conversation_id,
          messageId: mid,
          authorMemberId: agentMemberId,
          bodyMd,
          directMentionIds,
          isDm: await isDmConversation(a.conversation_id),
        }).catch(() => {});
      }
      out.trace.push(`share_files ${mid} (${fetched.length} file(s))`);
      return;
    }
    default:
      out.errors.push(`unknown_action: ${(a as { type: string }).type}`);
  }
}

async function loadAgentWorkspace(agentMemberId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: members.workspaceId })
    .from(members)
    .where(eq(members.id, agentMemberId))
    .limit(1);
  return row?.workspaceId ?? null;
}

async function isDmConversation(conversationId: string): Promise<boolean> {
  const [c] = await db
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return c?.kind === "dm";
}

// Server-side file ingest shared by share_files + share_to_task. Each source
// is either a URL (fetched over HTTPS) or an absolute /tmp path (read from
// disk). Output goes straight into storage under u/<id>/<name> and returns
// descriptor shape ready to paste into a message or task comment.
//
// Limits: 10 files per call, 20 MB per file, 15s per URL fetch. Anything
// that misses those just logs a trace line and is skipped — one bad source
// doesn't kill the whole action.
async function fetchAgentAttachments(
  files: Array<{ url?: string; path?: string; name?: string }>,
  trace: string[],
  actionLabel: "share_files" | "share_to_task",
): Promise<{ attachments: AgentAttachment[]; skips: string[] }> {
  const MAX_FILES = 10;
  const MAX_BYTES = 20 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 15_000;
  const slice = files.slice(0, MAX_FILES);

  // Snapshot the trace so we can hand the per-file skip reasons back to the
  // agent in the error too — not just bury them in the trace it never reads.
  // The #1 silent failure is an agent sharing a path it never wrote (wrong
  // name or subdir); without the reason it just retries the same bad path.
  const traceStart = trace.length;
  const fetched: AgentAttachment[] = [];
  for (const f of slice) {
    const rawUrl = typeof f?.url === "string" ? f.url : "";
    const rawPath = typeof f?.path === "string" ? f.path : "";
    const hasUrl = rawUrl.length > 0;
    const hasPath = rawPath.length > 0;
    if (hasUrl === hasPath) {
      trace.push(`${actionLabel} skip: exactly one of {url,path} required`);
      continue;
    }
    try {
      let buf: Buffer;
      let contentType = "application/octet-stream";
      let nameHint = "";

      if (hasUrl) {
        if (!/^https?:\/\//i.test(rawUrl)) {
          trace.push(`${actionLabel} skip: invalid url scheme`);
          continue;
        }
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(rawUrl, { signal: controller.signal, redirect: "follow" });
        clearTimeout(t);
        if (!res.ok) {
          trace.push(`${actionLabel} skip ${rawUrl}: HTTP ${res.status}`);
          continue;
        }
        buf = Buffer.from(await res.arrayBuffer());
        contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim() || contentType;
        try { nameHint = new URL(rawUrl).pathname.split("/").pop() ?? ""; } catch { nameHint = ""; }
      } else {
        // Local path: restrict to /tmp/ or the shared /workspace/ to prevent
        // arbitrary reads. /workspace is the cross-agent shared mount (files
        // there persist + are visible to every agent and to this API container,
        // which mounts the same host dir at /workspace); /tmp covers browser
        // pdf/screenshot outputs and agent-terminal scratch.
        const { resolve: pResolve } = await import("node:path");
        const { promises: fsp } = await import("node:fs");
        const abs = pResolve(rawPath);
        if (!abs.startsWith("/tmp/") && !abs.startsWith("/workspace/")) {
          trace.push(`${actionLabel} skip: path must be under /tmp/ or /workspace/ (got ${abs})`);
          continue;
        }
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat || !stat.isFile()) {
          trace.push(`${actionLabel} skip ${abs}: not a regular file`);
          continue;
        }
        if (stat.size > MAX_BYTES) {
          trace.push(`${actionLabel} skip ${abs}: ${stat.size}B > ${MAX_BYTES}B`);
          continue;
        }
        buf = await fsp.readFile(abs);
        nameHint = abs.split("/").pop() ?? "";
        const ext = (nameHint.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "").toLowerCase();
        const extMap: Record<string, string> = {
          pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          txt: "text/plain", md: "text/markdown", csv: "text/csv",
          json: "application/json", html: "text/html", xml: "application/xml",
          zip: "application/zip",
        };
        if (extMap[ext]) contentType = extMap[ext];
      }

      if (buf.length > MAX_BYTES) {
        trace.push(`${actionLabel} skip: ${buf.length}B > ${MAX_BYTES}B`);
        continue;
      }
      const rawName = (typeof f?.name === "string" && f.name.trim()) || nameHint || "file";
      const safeName = rawName.replace(/[^a-z0-9._-]/gi, "_").slice(0, 120) || "file";
      const key = `u/${id("f").slice(2)}/${safeName}`;
      await putObject(key, buf);
      fetched.push({ key, name: safeName, contentType, size: buf.length, url: publicUrl(key) });
    } catch (e) {
      trace.push(`${actionLabel} source ${hasUrl ? rawUrl : rawPath} failed: ${(e as Error).message}`);
    }
  }
  const skips = trace.slice(traceStart).filter((s) => s.includes(" skip") || s.includes(" failed:"));
  return { attachments: fetched, skips };
}

// Agents may emit attachments via post_message. Require the file to have been
// uploaded through /agent-api/uploads or /uploads first — enforce by shape only
// (the key + url are produced server-side on upload, so trust them if present).
export function sanitizeAttachments(input: unknown): AgentAttachment[] {
  if (!Array.isArray(input)) return [];
  const out: AgentAttachment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key : null;
    const name = typeof r.name === "string" ? r.name : null;
    const contentType = typeof r.contentType === "string" ? r.contentType : null;
    const size = typeof r.size === "number" && Number.isFinite(r.size) ? r.size : null;
    const url = typeof r.url === "string" ? r.url : null;
    if (!key || !name || !contentType || size === null || !url) continue;
    // Reject unexpected key prefixes so callers can't write outside /u/...
    if (!/^u\/[a-z0-9]+\//i.test(key)) continue;
    out.push({ key, name, contentType, size, url });
    if (out.length >= 10) break;
  }
  return out;
}
