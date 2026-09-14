import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  notifications,
  members,
  conversations,
  conversationMembers,
  users,
  agents,
  workspaceMembers,
} from "../db/schema.js";
import { id } from "./ids.js";
import { publishToMember } from "./events.js";
import { redis } from "./redis.js";

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
  // ── Recurrence control ────────────────────────────────────────────────
  // Set by machine-generated ("system") notifications that a periodic sweep can
  // re-derive every tick. With a key set, at most ONE row per key per
  // `dedupeWindowMs` is written, and none at all while an identical unread row
  // is still sitting in the recipient's inbox.
  //
  // Why: the goal sweeper's stall pass re-fired "A goal looks stalled — needs
  // your input" roughly every 21 minutes per stalled goal. On live that was
  // 41,001 of 43,423 notification rows, every one of them unread, saying the
  // same thing about the same nine goals. A notification nobody has read is
  // not made more useful by sending it 4,000 more times.
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

// Default recurrence window for keyed notifications: once per recipient per day.
export const DEFAULT_NOTIFY_DEDUPE_MS = 24 * 60 * 60 * 1000;

const dedupeRedisKey = (memberId: string, key: string): string =>
  `cc:ntf:dedupe:${memberId}:${key}`;

export interface UnreadLike {
  kind: string;
  title: string;
  body: string;
  link: string;
}

/**
 * True when the recipient already has an unread notification saying exactly
 * this. Pure so the rule is testable: "identical" means same kind, title, body
 * and deep-link — a stall alert whose body names a different goal is a
 * different notification and still gets through.
 */
export function hasIdenticalUnread(existing: UnreadLike[], candidate: UnreadLike): boolean {
  return existing.some(
    (e) =>
      e.kind === candidate.kind &&
      e.title === candidate.title &&
      e.body === candidate.body &&
      e.link === candidate.link,
  );
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

  if (input.dedupeKey && (await suppressedByDedupe(input))) return;

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

// Two independent gates, both cheap, both fail-open on infrastructure trouble
// (a notification that slips through is far better than one that never lands):
//   1. an identical UNREAD row already in the inbox → never pile another on;
//   2. a redis NX stamp per (member, key) → at most one per window, and it
//      survives worker restarts so a deploy loop can't reset the clock.
async function suppressedByDedupe(input: NotifyInput): Promise<boolean> {
  const windowMs = Math.max(1_000, input.dedupeWindowMs ?? DEFAULT_NOTIFY_DEDUPE_MS);
  const candidate: UnreadLike = {
    kind: input.kind,
    title: input.title ?? "",
    body: input.body ?? "",
    link: input.link ?? "",
  };

  try {
    const unread = await db
      .select({
        kind: notifications.kind,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.memberId, input.memberId),
          eq(notifications.kind, input.kind),
          isNull(notifications.readAt),
        ),
      )
      .orderBy(notifications.createdAt)
      .limit(50);
    if (hasIdenticalUnread(unread, candidate)) return true;
  } catch {
    /* fall through to the redis gate */
  }

  try {
    const stamped = await redis.set(
      dedupeRedisKey(input.memberId, input.dedupeKey!),
      "1",
      "PX",
      windowMs,
      "NX",
    );
    if (stamped !== "OK") return true;
  } catch {
    /* redis down — the unread check above is the remaining guard */
  }
  return false;
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

// Workspace admins' user-member ids — the default inbox for anything that
// needs a human decision (budget alerts, approvals, expiries).
export async function adminMemberIds(workspaceId: string): Promise<string[]> {
  const admins = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  if (!admins.length) return [];
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        eq(members.kind, "user"),
        inArray(members.refId, admins.map((a) => a.userId)),
      ),
    );
  return rows.map((r) => r.id);
}

// Who gets told about an approval: the admins; if a workspace has none (a
// solo owner whose role row was never set, an imported workspace), every
// human member — an approval card that nobody is told about is exactly the
// silent-forever queue observed in the wild (5 cards pending for two months
// with no notification ever written).
export async function approverMemberIds(workspaceId: string): Promise<string[]> {
  const admins = await adminMemberIds(workspaceId);
  if (admins.length) return admins;
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.kind, "user")));
  return rows.map((r) => r.id);
}

// Inbox + live event for every approver when an approval is opened, expired,
// or auto-approved. Best-effort: never throws (an inbox hiccup must not fail
// the agent's action). The body never carries payloads or secret values —
// only the agent, the scope, and the human-readable ask.
export async function notifyApprovers(
  workspaceId: string,
  msg: { kind?: NotificationKind; title: string; body: string; link?: string; actorMemberId?: string | null },
): Promise<void> {
  try {
    const recipients = await approverMemberIds(workspaceId);
    if (!recipients.length) return;
    await notifyMany(recipients, {
      workspaceId,
      kind: msg.kind ?? "approval",
      actorMemberId: msg.actorMemberId ?? null,
      title: msg.title,
      body: msg.body,
      link: msg.link ?? "/approvals",
    });
  } catch (e) {
    console.error("[notifications] approver fan-out failed", (e as Error).message);
  }
}
