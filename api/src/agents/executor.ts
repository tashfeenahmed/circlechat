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
  | { type: "call_tool"; name: string; args?: unknown };

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
    default:
      out.errors.push(`unknown_action: ${(a as { type: string }).type}`);
  }
}

// Agents may emit attachments via post_message. Require the file to have been
// uploaded through /agent-api/uploads or /uploads first — enforce by shape only
// (the key + url are produced server-side on upload, so trust them if present).
function sanitizeAttachments(input: unknown): AgentAttachment[] {
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
