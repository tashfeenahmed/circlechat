import { and, eq, gt, sql } from "drizzle-orm";
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
} from "../db/schema.js";
import { id } from "../lib/ids.js";
import { publishToConversation } from "../lib/events.js";
import { checkReplyBody } from "./reply-guard.js";
import { checkRecentDuplicate } from "./dedupe.js";
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
} from "../lib/tasks-core.js";
import { putObject, publicUrl } from "../lib/storage.js";

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
  | { type: "call_tool"; name: string; args?: unknown }
  // Task-board actions — let the agent runtime emit structured calls instead
  // of round-tripping curl through its terminal skill. Field names mirror the
  // `/agent-api/tasks` HTTP route bodies for consistency.
  | {
      type: "create_task";
      title: string;
      body_md?: string;
      status?: "backlog" | "in_progress" | "review" | "done";
      parent_id?: string;
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
      status?: "backlog" | "in_progress" | "review" | "done";
      progress?: number;
      due_at?: string | null;
      archived?: boolean;
    }
  | { type: "assign_task"; task_id: string; member_id: string }
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

  for (const a of params.actions) {
    try {
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
          guard.reason === "attachment_claim_no_file"
            ? `post_message rejected: ${guard.reason}. Your prose claims a file is attached but no attachment was sent. Either include the file via share_files in this turn, or rewrite to remove the attachment claim.`
            : `post_message rejected: ${guard.reason}`,
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
        out.errors.push(`update_task: ${r.error}`);
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
    case "task_comment": {
      const ws = await loadAgentWorkspace(agentMemberId);
      if (!ws) throw new Error("agent_workspace_missing");
      const hasAttachments = Array.isArray(a.attachments) && a.attachments.length > 0;
      const guard = checkReplyBody(a.body_md, { hasAttachments });
      if (!guard.ok) {
        out.errors.push(
          guard.reason === "attachment_claim_no_file"
            ? `task_comment rejected: ${guard.reason}. Your prose claims a file is attached but no attachment was sent. Use share_to_task to ship the file in the same turn, or rewrite to drop the claim.`
            : `task_comment rejected: ${guard.reason}`,
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
      const rawBody = typeof a.body_md === "string" ? a.body_md : "";
      const guard = checkReplyBody(rawBody || "(attachments)");
      const bodyMd = guard.ok ? guard.bodyMd : rawBody;
      const files = Array.isArray(a.files) ? a.files : [];
      const fetched = await fetchAgentAttachments(files, out.trace, "share_to_task");
      if (fetched.length === 0) {
        out.errors.push(`share_to_task: no files fetched from ${files.length} source(s)`);
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
      out.trace.push(`share_to_task on ${a.task_id} (${fetched.length} file${fetched.length === 1 ? "" : "s"})`);
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
      const fetched = await fetchAgentAttachments(files, out.trace, "share_files");

      if (fetched.length === 0) {
        out.errors.push(`share_files: no files fetched from ${files.length} url(s)`);
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
): Promise<AgentAttachment[]> {
  const MAX_FILES = 10;
  const MAX_BYTES = 20 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 15_000;
  const slice = files.slice(0, MAX_FILES);

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
        // Local path: restrict to /tmp/ to prevent arbitrary reads. The
        // browser pdf/screenshot commands save here by convention, and
        // agent-terminal shell blocks default to /tmp scratch space.
        const { resolve: pResolve } = await import("node:path");
        const { promises: fsp } = await import("node:fs");
        const abs = pResolve(rawPath);
        if (!abs.startsWith("/tmp/")) {
          trace.push(`${actionLabel} skip: path must be under /tmp/ (got ${abs})`);
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
  return fetched;
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
