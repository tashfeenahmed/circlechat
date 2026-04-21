import { and, eq, gt, inArray, desc, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  members,
  conversations,
  conversationMembers,
  messages,
  approvals,
  memoryKv,
  reactions,
  users,
} from "../db/schema.js";
import { loadReportingFor, type ReportingBundle } from "../routes/org.js";

export interface MemberInfo {
  memberId: string;
  kind: "user" | "agent";
  name: string;
  handle: string;
  isMe?: boolean;
}

export interface InboxReaction {
  emoji: string;
  memberId: string;
  memberHandle: string;
}

export interface InboxAttachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

export interface InboxMessage {
  id: string;
  memberId: string;
  memberHandle: string;
  memberName: string;
  bodyMd: string;
  parentId: string | null;
  ts: string;
  mentions: string[];
  reactions: InboxReaction[];
  attachments: InboxAttachment[];
}

export interface ContextPacket {
  agent: {
    id: string;
    memberId: string;
    handle: string;
    name: string;
    model: string;
    scopes: string[];
    brief: string;
  };
  trigger: string;
  triggerConversationId?: string | null;
  triggerMessageId?: string;
  members: Record<string, MemberInfo>; // member directory keyed by memberId
  thread: null | {
    conversationId: string;
    conversationKind: string;
    conversationName: string | null;
    rootMessageId: string;
    messages: InboxMessage[];
  };
  inbox: Array<{
    conversationId: string;
    conversationKind: string;
    conversationName: string | null;
    conversationTopic: string;
    conversationMembers: string[]; // memberIds
    messages: InboxMessage[];
  }>;
  openApprovals: Array<{
    id: string;
    scope: string;
    action: string;
    status: string;
    createdAt: string;
  }>;
  memory: Record<string, unknown>;
  reporting: ReportingBundle;
}

export async function buildContext(opts: {
  agentId: string;
  trigger: string;
  sinceTs: Date;
  untilTs: Date;
  conversationId?: string | null;
  messageId?: string;
}): Promise<ContextPacket> {
  const [a] = await db.select().from(agents).where(eq(agents.id, opts.agentId)).limit(1);
  if (!a) throw new Error("agent_not_found");

  const [agentMember] = await db
    .select()
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, opts.agentId)))
    .limit(1);
  const agentMemberId = agentMember?.id ?? "";

  // Conversations the agent belongs to.
  const myConvs = await db
    .select({
      conversation: conversations,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.memberId, agentMemberId));

  const convIds = myConvs.map((c) => c.conversation.id);

  // For channel context — include the LAST N messages (not just since last beat) when
  // we've been woken by mention/dm so the agent knows what's already been said.
  const includeHistory = opts.trigger !== "scheduled";
  const historyLimit = 20;
  const historyMsgs = convIds.length && includeHistory
    ? await db
        .select()
        .from(messages)
        .where(inArray(messages.conversationId, convIds))
        .orderBy(desc(messages.ts))
        .limit(historyLimit * convIds.length)
    : [];
  const newMsgs = convIds.length
    ? await db
        .select()
        .from(messages)
        .where(
          and(
            inArray(messages.conversationId, convIds),
            gt(messages.ts, opts.sinceTs),
          ),
        )
        .orderBy(desc(messages.ts))
        .limit(200)
    : [];

  // Merge-deduped by id, most-recent-first.
  const byId = new Map<string, (typeof newMsgs)[number]>();
  for (const m of [...newMsgs, ...historyMsgs]) if (!byId.has(m.id)) byId.set(m.id, m);
  const all = Array.from(byId.values()).sort((a, b) => +b.ts - +a.ts);

  const byConv = new Map<string, typeof newMsgs>();
  for (const m of all) {
    const list = byConv.get(m.conversationId) ?? [];
    if (list.length < historyLimit) list.push(m);
    byConv.set(m.conversationId, list);
  }

  // Resolve every memberId referenced into a directory.
  const relatedConvMemberRows = convIds.length
    ? await db
        .select({ memberId: conversationMembers.memberId, conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(inArray(conversationMembers.conversationId, convIds))
    : [];
  const memberIds = new Set<string>();
  for (const r of relatedConvMemberRows) memberIds.add(r.memberId);
  for (const m of all) memberIds.add(m.memberId);
  memberIds.add(agentMemberId);

  const memberDirectory: Record<string, MemberInfo> = {};
  if (memberIds.size) {
    const memberRows = await db
      .select()
      .from(members)
      .where(inArray(members.id, Array.from(memberIds)));
    const userRefs = memberRows.filter((m) => m.kind === "user").map((m) => m.refId);
    const agentRefs = memberRows.filter((m) => m.kind === "agent").map((m) => m.refId);
    const uRows = userRefs.length
      ? await db.select().from(users).where(inArray(users.id, userRefs))
      : [];
    const aRows = agentRefs.length
      ? await db.select().from(agents).where(inArray(agents.id, agentRefs))
      : [];
    const uMap = new Map(uRows.map((u) => [u.id, u]));
    const aMap = new Map(aRows.map((a) => [a.id, a]));
    for (const m of memberRows) {
      if (m.kind === "user") {
        const u = uMap.get(m.refId);
        if (u) memberDirectory[m.id] = { memberId: m.id, kind: "user", name: u.name, handle: u.handle };
      } else {
        const ag = aMap.get(m.refId);
        if (ag) memberDirectory[m.id] = {
          memberId: m.id,
          kind: "agent",
          name: ag.name,
          handle: ag.handle,
          isMe: m.id === agentMemberId,
        };
      }
    }
  }

  const convMembersByConv = new Map<string, string[]>();
  for (const r of relatedConvMemberRows) {
    const arr = convMembersByConv.get(r.conversationId) ?? [];
    arr.push(r.memberId);
    convMembersByConv.set(r.conversationId, arr);
  }

  // Pull reactions for every message id we might return (inbox + thread).
  const candidateMsgIds = new Set<string>();
  for (const m of all) candidateMsgIds.add(m.id);
  if (opts.messageId) candidateMsgIds.add(opts.messageId);
  const rxRows = candidateMsgIds.size
    ? await db.select().from(reactions).where(inArray(reactions.messageId, Array.from(candidateMsgIds)))
    : [];
  const rxByMsg = new Map<string, InboxReaction[]>();
  for (const r of rxRows) {
    const list = rxByMsg.get(r.messageId) ?? [];
    list.push({
      emoji: r.emoji,
      memberId: r.memberId,
      memberHandle: memberDirectory[r.memberId]?.handle ?? "unknown",
    });
    rxByMsg.set(r.messageId, list);
  }

  const inbox = myConvs
    .map(({ conversation }) => {
      const convMsgs = (byConv.get(conversation.id) ?? [])
        .reverse()
        .slice(-historyLimit)
        .map((m) => {
          const who = memberDirectory[m.memberId];
          return {
            id: m.id,
            memberId: m.memberId,
            memberHandle: who?.handle ?? "unknown",
            memberName: who?.name ?? "unknown",
            bodyMd: m.bodyMd,
            parentId: m.parentId,
            ts: m.ts.toISOString(),
            mentions: m.mentions,
            reactions: rxByMsg.get(m.id) ?? [],
            attachments: (m.attachmentsJson ?? []) as InboxAttachment[],
          };
        });
      return {
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        conversationName: conversation.name,
        conversationTopic: conversation.topic,
        conversationMembers: convMembersByConv.get(conversation.id) ?? [],
        messages: convMsgs,
      };
    })
    .filter((c) => c.messages.length > 0)
    // Sort so the triggering conversation is first.
    .sort((a, b) => (a.conversationId === opts.conversationId ? -1 : b.conversationId === opts.conversationId ? 1 : 0));

  const open = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.agentId, opts.agentId), eq(approvals.status, "pending")))
    .limit(50);

  const memRows = await db.select().from(memoryKv).where(eq(memoryKv.agentId, opts.agentId));
  const memory: Record<string, unknown> = {};
  for (const r of memRows) memory[r.key] = r.valueJson;

  // If the triggering message is inside (or is the root of) a thread, pull the
  // whole thread regardless of age so the agent has the full local context.
  let thread: ContextPacket["thread"] = null;
  if (opts.messageId) {
    const [trig] = await db.select().from(messages).where(eq(messages.id, opts.messageId)).limit(1);
    if (trig) {
      const rootId = trig.parentId ?? trig.id;
      const [rootMsg] = await db.select().from(messages).where(eq(messages.id, rootId)).limit(1);
      const replies = await db
        .select()
        .from(messages)
        .where(eq(messages.parentId, rootId))
        .orderBy(asc(messages.ts));
      const chain = [rootMsg, ...replies].filter(Boolean) as typeof replies;
      // Ensure every author is in the directory.
      const missing = chain
        .map((m) => m.memberId)
        .filter((mid) => !memberDirectory[mid]);
      if (missing.length) {
        const extra = await db.select().from(members).where(inArray(members.id, missing));
        const uRefs = extra.filter((m) => m.kind === "user").map((m) => m.refId);
        const aRefs = extra.filter((m) => m.kind === "agent").map((m) => m.refId);
        const uX = uRefs.length ? await db.select().from(users).where(inArray(users.id, uRefs)) : [];
        const aX = aRefs.length ? await db.select().from(agents).where(inArray(agents.id, aRefs)) : [];
        const uXM = new Map(uX.map((u) => [u.id, u]));
        const aXM = new Map(aX.map((a) => [a.id, a]));
        for (const m of extra) {
          if (m.kind === "user") {
            const u = uXM.get(m.refId);
            if (u) memberDirectory[m.id] = { memberId: m.id, kind: "user", name: u.name, handle: u.handle };
          } else {
            const ag = aXM.get(m.refId);
            if (ag) memberDirectory[m.id] = {
              memberId: m.id,
              kind: "agent",
              name: ag.name,
              handle: ag.handle,
              isMe: m.id === agentMemberId,
            };
          }
        }
      }
      if (chain.length > 1 || (rootMsg && trig.parentId)) {
        const [conv] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, chain[0]!.conversationId))
          .limit(1);
        // Thread reactions — fetch fresh if we haven't already pulled them.
        const threadIds = chain.map((m) => m.id);
        const missingIds = threadIds.filter((id) => !rxByMsg.has(id));
        if (missingIds.length) {
          const extraRx = await db
            .select()
            .from(reactions)
            .where(inArray(reactions.messageId, missingIds));
          for (const r of extraRx) {
            const list = rxByMsg.get(r.messageId) ?? [];
            list.push({
              emoji: r.emoji,
              memberId: r.memberId,
              memberHandle: memberDirectory[r.memberId]?.handle ?? "unknown",
            });
            rxByMsg.set(r.messageId, list);
          }
        }
        thread = {
          conversationId: chain[0]!.conversationId,
          conversationKind: conv?.kind ?? "channel",
          conversationName: conv?.name ?? null,
          rootMessageId: rootId,
          messages: chain.map((m) => ({
            id: m.id,
            memberId: m.memberId,
            memberHandle: memberDirectory[m.memberId]?.handle ?? "unknown",
            memberName: memberDirectory[m.memberId]?.name ?? "unknown",
            bodyMd: m.bodyMd,
            parentId: m.parentId,
            ts: m.ts.toISOString(),
            mentions: m.mentions,
            reactions: rxByMsg.get(m.id) ?? [],
            attachments: (m.attachmentsJson ?? []) as InboxAttachment[],
          })),
        };
      }
    }
  }

  const reporting = await loadReportingFor(a.workspaceId, agentMemberId);

  return {
    agent: {
      id: a.id,
      memberId: agentMemberId,
      handle: a.handle,
      name: a.name,
      model: a.model,
      scopes: a.scopes,
      brief: a.brief,
    },
    trigger: opts.trigger,
    triggerConversationId: opts.conversationId ?? null,
    triggerMessageId: opts.messageId,
    members: memberDirectory,
    thread,
    inbox,
    openApprovals: open.map((o) => ({
      id: o.id,
      scope: o.scope,
      action: o.action,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    })),
    memory,
    reporting,
  };
}
