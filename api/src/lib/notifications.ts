import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  notifications,
  members,
  conversations,
  conversationMembers,
  users,
  agents,
} from "../db/schema.js";
import { id } from "./ids.js";
import { publishToMember } from "./events.js";

export type NotificationKind =
  | "mention"
  | "dm"
  | "task_assigned"
  | "task_comment"
  | "approval"
  | "system";

export interface NotifyInput {
  workspaceId: string;
  // Recipient member id. If it resolves to an agent member, the notification
  // is skipped — agents get woken by triggers, not by this inbox.
  memberId: string;
  kind: NotificationKind;
  actorMemberId?: string | null;
  title?: string;
  body?: string;
  link?: string;
  conversationId?: string | null;
  messageId?: string | null;
  taskId?: string | null;
}

// Insert one notification row + push a live event to the recipient. Best-effort
// and self-contained: callers fire-and-forget this (never block the user's
// action on a notification write). Skips agent recipients and self-notifies.
export async function notify(input: NotifyInput): Promise<void> {
  if (!input.memberId || !input.workspaceId) return;
  // Don't notify an actor about their own action.
  if (input.actorMemberId && input.actorMemberId === input.memberId) return;

  // Only user members have an inbox — agents are driven by triggers.
  const [m] = await db
    .select({ kind: members.kind })
    .from(members)
    .where(eq(members.id, input.memberId))
    .limit(1);
  if (!m || m.kind !== "user") return;

  const nid = id("ntf");
  const now = new Date();
  const row = {
    id: nid,
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    kind: input.kind,
    actorMemberId: input.actorMemberId ?? null,
    title: input.title ?? "",
    body: input.body ?? "",
    link: input.link ?? "",
    conversationId: input.conversationId ?? null,
    messageId: input.messageId ?? null,
    taskId: input.taskId ?? null,
    readAt: null as Date | null,
    createdAt: now,
  };
  await db.insert(notifications).values(row);
  await publishToMember(input.memberId, {
    type: "notification.new",
    memberId: input.memberId,
    notification: { ...row, createdAt: now.toISOString(), readAt: null },
  });
}

// Fan a notification out to many recipients (e.g. everyone @-mentioned in a
// message). Dedupes the recipient list and runs the writes concurrently;
// individual failures are swallowed so one bad recipient can't sink the rest.
export async function notifyMany(
  recipients: string[],
  base: Omit<NotifyInput, "memberId">,
): Promise<void> {
  const unique = Array.from(new Set(recipients.filter(Boolean)));
  await Promise.all(
    unique.map((memberId) => notify({ ...base, memberId }).catch(() => {})),
  );
}

// Notify human members about a newly-posted message. Both the human post path
// (routes/messages.ts) and the agent post path (executor.ts) call this once,
// after the message lands. Agents are intentionally NOT notified here — they
// react to triggers, not the inbox. Rules:
//   • DM  → notify every other human member of the conversation
//   • direct @-mention in a channel → notify each mentioned human
// Broadcast (@everyone/@channel) is deliberately excluded to avoid inbox spam;
// it still fires agent triggers via the caller's existing logic.
//
// Fire-and-forget: callers should not await this on the request hot path.
export async function notifyForMessage(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  authorMemberId: string;
  bodyMd: string;
  directMentionIds: string[];
  isDm: boolean;
}): Promise<void> {
  const { workspaceId, conversationId, messageId, authorMemberId, isDm } = params;

  const recipients = new Set<string>();
  if (isDm) {
    const cmembers = await db
      .select({ memberId: conversationMembers.memberId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId));
    for (const r of cmembers) {
      if (r.memberId !== authorMemberId) recipients.add(r.memberId);
    }
  }
  for (const mid of params.directMentionIds) recipients.add(mid);
  recipients.delete(authorMemberId);
  if (recipients.size === 0) return;

  // Resolve the author's display name once for the notification title.
  const actorName = await resolveMemberName(params.authorMemberId);
  const [conv] = await db
    .select({ name: conversations.name, kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const snippet = params.bodyMd.replace(/\s+/g, " ").trim().slice(0, 140);
  const kind = isDm ? "dm" : "mention";
  const title = isDm
    ? `${actorName} messaged you`
    : `${actorName} mentioned you${conv?.name ? ` in #${conv.name}` : ""}`;

  await notifyMany(Array.from(recipients), {
    workspaceId,
    kind,
    actorMemberId: params.authorMemberId,
    title,
    body: snippet,
    link: `/c/${conversationId}`,
    conversationId,
    messageId,
  });
}

// Resolve a member id to a human-readable name (user.name or agent.name).
// Falls back to "Someone" so notification titles never render "undefined".
async function resolveMemberName(memberId: string): Promise<string> {
  const [m] = await db
    .select({ kind: members.kind, refId: members.refId })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  if (!m) return "Someone";
  if (m.kind === "user") {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, m.refId)).limit(1);
    return u?.name ?? "Someone";
  }
  const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, m.refId)).limit(1);
  return a?.name ?? "Someone";
}

// Filter a list of member ids down to those that are human (user) members —
// handy for callers that have a mixed mention list and only want to notify
// people. Kept here so the join logic lives next to notify().
export async function humanMembersOf(memberIds: string[]): Promise<string[]> {
  const unique = Array.from(new Set(memberIds.filter(Boolean)));
  if (!unique.length) return [];
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(inArray(members.id, unique), eq(members.kind, "user")));
  return rows.map((r) => r.id);
}
