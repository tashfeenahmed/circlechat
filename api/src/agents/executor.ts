import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  messages,
  reactions,
  approvals,
  members,
  conversations,
  conversationMembers,
  memoryKv,
} from "../db/schema.js";
import { id } from "../lib/ids.js";
import { publishToConversation } from "../lib/events.js";
import { checkReplyBody } from "./reply-guard.js";
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
  | { type: "set_memory"; key: string; value: unknown }
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
  | { type: "task_comment"; task_id: string; body_md: string; mentions?: string[] }
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
      const guard = checkReplyBody(a.body_md);
      if (!guard.ok) {
        out.trace.push(`post_message rejected (${guard.reason})`);
        out.errors.push(`post_message rejected: ${guard.reason}`);
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
      await db
        .insert(memoryKv)
        .values({ agentId, key: a.key, valueJson: a.value as never })
        .onConflictDoUpdate({
          target: [memoryKv.agentId, memoryKv.key],
          set: { valueJson: a.value as never, updatedAt: new Date() },
        });
      out.trace.push(`set_memory ${a.key}`);
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
      const guard = checkReplyBody(a.body_md);
      if (!guard.ok) {
        out.errors.push(`task_comment rejected: ${guard.reason}`);
        return;
      }
      const r = await addComment(
        a.task_id,
        guard.bodyMd,
        Array.isArray(a.mentions) ? a.mentions : [],
        agentMemberId,
        ws,
      );
      if ("error" in r) {
        out.errors.push(`task_comment: ${r.error}`);
        return;
      }
      out.trace.push(`task_comment on ${a.task_id}`);
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

      const MAX_FILES = 10;
      const MAX_BYTES = 20 * 1024 * 1024;
      const FETCH_TIMEOUT_MS = 15_000;
      const files = Array.isArray(a.files) ? a.files.slice(0, MAX_FILES) : [];

      const fetched: AgentAttachment[] = [];
      for (const f of files) {
        const rawUrl = typeof f?.url === "string" ? f.url : "";
        const rawPath = typeof f?.path === "string" ? f.path : "";
        const hasUrl = rawUrl.length > 0;
        const hasPath = rawPath.length > 0;
        if (hasUrl === hasPath) {
          out.trace.push(`share_files skip: exactly one of {url,path} required`);
          continue;
        }
        try {
          let buf: Buffer;
          let contentType = "application/octet-stream";
          let nameHint = "";

          if (hasUrl) {
            if (!/^https?:\/\//i.test(rawUrl)) {
              out.trace.push(`share_files skip: invalid url scheme`);
              continue;
            }
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const res = await fetch(rawUrl, { signal: controller.signal, redirect: "follow" });
            clearTimeout(t);
            if (!res.ok) {
              out.trace.push(`share_files skip ${rawUrl}: HTTP ${res.status}`);
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
              out.trace.push(`share_files skip: path must be under /tmp/ (got ${abs})`);
              continue;
            }
            const stat = await fsp.stat(abs).catch(() => null);
            if (!stat || !stat.isFile()) {
              out.trace.push(`share_files skip ${abs}: not a regular file`);
              continue;
            }
            if (stat.size > MAX_BYTES) {
              out.trace.push(`share_files skip ${abs}: ${stat.size}B > ${MAX_BYTES}B`);
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
            out.trace.push(`share_files skip: ${buf.length}B > ${MAX_BYTES}B`);
            continue;
          }
          const rawName = (typeof f?.name === "string" && f.name.trim()) || nameHint || "file";
          const safeName = rawName.replace(/[^a-z0-9._-]/gi, "_").slice(0, 120) || "file";
          const key = `u/${id("f").slice(2)}/${safeName}`;
          await putObject(key, buf);
          fetched.push({ key, name: safeName, contentType, size: buf.length, url: publicUrl(key) });
        } catch (e) {
          out.trace.push(`share_files source ${hasUrl ? rawUrl : rawPath} failed: ${(e as Error).message}`);
        }
      }

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
