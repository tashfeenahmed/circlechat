import { and, eq, inArray, asc, desc, or, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  tasks,
  taskAssignees,
  taskLabels,
  taskLinks,
  taskComments,
  taskActivity,
  conversations,
  conversationMembers,
  members,
} from "../db/schema.js";
import { id } from "./ids.js";
import { publishToConversation } from "./events.js";
import { enqueueAgentEvent } from "../agents/enqueue.js";

export const STATUSES = ["backlog", "in_progress", "review", "done"] as const;
export type Status = (typeof STATUSES)[number];

type TaskRow = typeof tasks.$inferSelect;

export async function assertConvMember(conversationId: string, memberId: string): Promise<boolean> {
  const [mm] = await db
    .select({ role: conversationMembers.role })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.memberId, memberId),
      ),
    )
    .limit(1);
  return !!mm;
}

export async function loadTask(taskId: string): Promise<TaskRow | null> {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return t ?? null;
}

export async function hydrateTasks(
  rows: TaskRow[],
): Promise<
  Array<
    TaskRow & {
      assignees: string[];
      labels: string[];
      subtaskCount: number;
      commentCount: number;
      linkCount: number;
    }
  >
> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [as, ls, subs, coms, lks] = await Promise.all([
    db.select().from(taskAssignees).where(inArray(taskAssignees.taskId, ids)),
    db.select().from(taskLabels).where(inArray(taskLabels.taskId, ids)),
    db
      .select({ parentId: tasks.parentId, c: dsql<number>`count(*)::int`.as("c") })
      .from(tasks)
      .where(inArray(tasks.parentId, ids))
      .groupBy(tasks.parentId),
    db
      .select({ taskId: taskComments.taskId, c: dsql<number>`count(*)::int`.as("c") })
      .from(taskComments)
      .where(and(inArray(taskComments.taskId, ids), dsql`${taskComments.deletedAt} is null` as never))
      .groupBy(taskComments.taskId),
    db
      .select({ taskId: taskLinks.taskId, c: dsql<number>`count(*)::int`.as("c") })
      .from(taskLinks)
      .where(inArray(taskLinks.taskId, ids))
      .groupBy(taskLinks.taskId),
  ]);
  const aMap = new Map<string, string[]>();
  for (const r of as) {
    const arr = aMap.get(r.taskId) ?? [];
    arr.push(r.memberId);
    aMap.set(r.taskId, arr);
  }
  const lMap = new Map<string, string[]>();
  for (const r of ls) {
    const arr = lMap.get(r.taskId) ?? [];
    arr.push(r.label);
    lMap.set(r.taskId, arr);
  }
  const sMap = new Map(subs.map((r) => [r.parentId ?? "", Number(r.c) || 0]));
  const cMap = new Map(coms.map((r) => [r.taskId, Number(r.c) || 0]));
  const kMap = new Map(lks.map((r) => [r.taskId, Number(r.c) || 0]));
  return rows.map((r) => ({
    ...r,
    assignees: aMap.get(r.id) ?? [],
    labels: lMap.get(r.id) ?? [],
    subtaskCount: sMap.get(r.id) ?? 0,
    commentCount: cMap.get(r.id) ?? 0,
    linkCount: kMap.get(r.id) ?? 0,
  }));
}

export async function logActivity(
  taskId: string,
  actorMemberId: string,
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(taskActivity).values({
    id: id("act"),
    taskId,
    actorMemberId,
    kind,
    payload,
  });
}

export async function maybeFireAgentTrigger(
  memberId: string,
  taskId: string,
  conversationId: string,
  trigger: "task_assigned" | "task_comment",
): Promise<void> {
  const [m] = await db
    .select({ kind: members.kind, refId: members.refId })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  if (!m || m.kind !== "agent") return;
  await enqueueAgentEvent(m.refId, { trigger, conversationId, taskId });
}

// ───── list / get ─────

export async function listTasks(conversationId: string, memberId: string) {
  if (!(await assertConvMember(conversationId, memberId))) return { error: "not_a_member" as const };
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.conversationId, conversationId), eq(tasks.archived, false)))
    .orderBy(asc(tasks.status), asc(tasks.position), asc(tasks.createdAt));
  return { tasks: await hydrateTasks(rows) };
}

export async function getTaskDetail(taskId: string, memberId: string) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, memberId))) return { error: "not_a_member" as const };
  const [hydrated] = await hydrateTasks([t]);
  const subs = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentId, taskId), eq(tasks.archived, false)))
    .orderBy(asc(tasks.position), asc(tasks.createdAt));
  const subHydrated = await hydrateTasks(subs);
  const links = await db
    .select({
      id: taskLinks.id,
      linkedTaskId: taskLinks.linkedTaskId,
      kind: taskLinks.kind,
      createdAt: taskLinks.createdAt,
    })
    .from(taskLinks)
    .where(eq(taskLinks.taskId, taskId));
  const linkedIds = links.map((l) => l.linkedTaskId);
  const linkedRows = linkedIds.length
    ? await db.select().from(tasks).where(inArray(tasks.id, linkedIds))
    : [];
  const linkedMap = new Map(linkedRows.map((r) => [r.id, r]));
  const comments = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.taskId, taskId), dsql`${taskComments.deletedAt} is null` as never))
    .orderBy(asc(taskComments.ts));
  const activity = await db
    .select()
    .from(taskActivity)
    .where(eq(taskActivity.taskId, taskId))
    .orderBy(desc(taskActivity.ts))
    .limit(50);
  return {
    task: hydrated,
    subtasks: subHydrated,
    links: links.map((l) => ({ ...l, linked: linkedMap.get(l.linkedTaskId) ?? null })),
    comments,
    activity,
  };
}

// ───── create / update / delete ─────

export interface CreateTaskInput {
  conversationId: string;
  title: string;
  bodyMd?: string;
  status?: Status;
  parentId?: string;
  sourceMessageId?: string;
  assignees?: string[];
  labels?: string[];
  dueAt?: string | null;
  position?: number;
}

export async function createTask(input: CreateTaskInput, creatorMemberId: string, workspaceId: string) {
  if (!(await assertConvMember(input.conversationId, creatorMemberId))) {
    return { error: "not_a_member" as const };
  }
  const [conv] = await db
    .select({ id: conversations.id, kind: conversations.kind, workspaceId: conversations.workspaceId })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (!conv) return { error: "conversation_not_found" as const };
  if (conv.workspaceId !== workspaceId) return { error: "wrong_workspace" as const };
  if (conv.kind !== "channel") return { error: "dm_board_unsupported" as const };
  if (input.parentId) {
    const parent = await loadTask(input.parentId);
    if (!parent || parent.conversationId !== input.conversationId)
      return { error: "invalid_parent" as const };
  }
  const status: Status = input.status ?? "backlog";
  let position = input.position;
  if (position === undefined) {
    const [maxRow] = await db
      .select({ m: dsql<number>`coalesce(max(${tasks.position}), 0)`.as("m") })
      .from(tasks)
      .where(and(eq(tasks.conversationId, input.conversationId), eq(tasks.status, status)));
    position = (Number(maxRow?.m) || 0) + 1;
  }
  const taskId = id("task");
  await db.insert(tasks).values({
    id: taskId,
    conversationId: input.conversationId,
    parentId: input.parentId ?? null,
    title: input.title,
    bodyMd: input.bodyMd ?? "",
    status,
    position,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    progress: 0,
    createdBy: creatorMemberId,
    sourceMessageId: input.sourceMessageId ?? null,
    archived: false,
  });
  const assignees = Array.from(new Set(input.assignees ?? []));
  if (assignees.length) {
    await db
      .insert(taskAssignees)
      .values(assignees.map((mid) => ({ taskId, memberId: mid, assignedBy: creatorMemberId })))
      .onConflictDoNothing();
  }
  const labels = Array.from(new Set((input.labels ?? []).map((l) => l.trim()).filter(Boolean)));
  if (labels.length) {
    await db
      .insert(taskLabels)
      .values(labels.map((label) => ({ taskId, label })))
      .onConflictDoNothing();
  }
  await logActivity(taskId, creatorMemberId, "created");
  if (assignees.length) {
    await logActivity(taskId, creatorMemberId, "assigned", { members: assignees });
  }
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const [hydrated] = await hydrateTasks([row]);
  await publishToConversation(input.conversationId, {
    type: "task.new",
    conversationId: input.conversationId,
    task: hydrated,
  });
  for (const mid of assignees) {
    await maybeFireAgentTrigger(mid, taskId, input.conversationId, "task_assigned");
  }
  return { task: hydrated };
}

export interface UpdateTaskInput {
  title?: string;
  bodyMd?: string;
  status?: Status;
  position?: number;
  dueAt?: string | null;
  progress?: number;
  archived?: boolean;
}

export async function updateTask(taskId: string, input: UpdateTaskInput, actorMemberId: string) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.bodyMd !== undefined) patch.bodyMd = input.bodyMd;
  if (input.status !== undefined) patch.status = input.status;
  if (input.position !== undefined) patch.position = input.position;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.progress !== undefined) patch.progress = input.progress;
  if (input.archived !== undefined) patch.archived = input.archived;
  await db.update(tasks).set(patch).where(eq(tasks.id, taskId));
  if (input.status !== undefined && input.status !== t.status) {
    await logActivity(taskId, actorMemberId, "status_changed", { from: t.status, to: input.status });
  }
  if (input.title !== undefined && input.title !== t.title) {
    await logActivity(taskId, actorMemberId, "renamed", { from: t.title, to: input.title });
  }
  if (input.progress !== undefined && input.progress !== t.progress) {
    await logActivity(taskId, actorMemberId, "progress_changed", { to: input.progress });
  }
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const [hydrated] = await hydrateTasks([row]);
  await publishToConversation(t.conversationId, {
    type: "task.updated",
    conversationId: t.conversationId,
    taskId,
    task: hydrated,
  });
  return { task: hydrated };
}

export async function deleteTask(taskId: string, actorMemberId: string) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  const subIds = (
    await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, taskId))
  ).map((r) => r.id);
  const allIds = [taskId, ...subIds];
  await db.delete(taskComments).where(inArray(taskComments.taskId, allIds));
  await db.delete(taskAssignees).where(inArray(taskAssignees.taskId, allIds));
  await db.delete(taskLabels).where(inArray(taskLabels.taskId, allIds));
  await db
    .delete(taskLinks)
    .where(or(inArray(taskLinks.taskId, allIds), inArray(taskLinks.linkedTaskId, allIds)));
  await db.delete(taskActivity).where(inArray(taskActivity.taskId, allIds));
  await db.delete(tasks).where(inArray(tasks.id, allIds));
  await publishToConversation(t.conversationId, {
    type: "task.deleted",
    conversationId: t.conversationId,
    taskId,
  });
  return { ok: true as const };
}

// ───── assignees / labels / links / comments ─────

export async function addAssignee(taskId: string, target: string, actorMemberId: string, workspaceId: string) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  const [tm] = await db
    .select({ workspaceId: members.workspaceId })
    .from(members)
    .where(eq(members.id, target))
    .limit(1);
  if (!tm || tm.workspaceId !== workspaceId) return { error: "invalid_assignee" as const };
  await db
    .insert(taskAssignees)
    .values({ taskId, memberId: target, assignedBy: actorMemberId })
    .onConflictDoNothing();
  await logActivity(taskId, actorMemberId, "assigned", { member: target });
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const [hydrated] = await hydrateTasks([row]);
  await publishToConversation(t.conversationId, {
    type: "task.assigned",
    conversationId: t.conversationId,
    taskId,
    memberId: target,
    assignedBy: actorMemberId,
  });
  await publishToConversation(t.conversationId, {
    type: "task.updated",
    conversationId: t.conversationId,
    taskId,
    task: hydrated,
  });
  await maybeFireAgentTrigger(target, taskId, t.conversationId, "task_assigned");
  return { task: hydrated };
}

export async function removeAssignee(taskId: string, target: string, actorMemberId: string) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  await db
    .delete(taskAssignees)
    .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.memberId, target)));
  await logActivity(taskId, actorMemberId, "unassigned", { member: target });
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const [hydrated] = await hydrateTasks([row]);
  await publishToConversation(t.conversationId, {
    type: "task.unassigned",
    conversationId: t.conversationId,
    taskId,
    memberId: target,
  });
  await publishToConversation(t.conversationId, {
    type: "task.updated",
    conversationId: t.conversationId,
    taskId,
    task: hydrated,
  });
  return { task: hydrated };
}

export async function setLabels(taskId: string, labels: string[], actorMemberId: string) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  const next = Array.from(new Set(labels.map((l) => l.trim()).filter(Boolean)));
  await db.delete(taskLabels).where(eq(taskLabels.taskId, taskId));
  if (next.length) {
    await db.insert(taskLabels).values(next.map((label) => ({ taskId, label })));
  }
  await logActivity(taskId, actorMemberId, "labels_changed", { labels: next });
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const [hydrated] = await hydrateTasks([row]);
  await publishToConversation(t.conversationId, {
    type: "task.updated",
    conversationId: t.conversationId,
    taskId,
    task: hydrated,
  });
  return { task: hydrated };
}

export async function addLink(
  taskId: string,
  linkedTaskId: string,
  kind: "relates" | "blocks" | "duplicate",
  actorMemberId: string,
) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  if (linkedTaskId === taskId) return { error: "cannot_link_to_self" as const };
  const linked = await loadTask(linkedTaskId);
  if (!linked) return { error: "linked_not_found" as const };
  if (
    linked.conversationId !== t.conversationId &&
    !(await assertConvMember(linked.conversationId, actorMemberId))
  ) {
    return { error: "not_a_member_of_linked" as const };
  }
  const linkId = id("tlnk");
  await db
    .insert(taskLinks)
    .values({
      id: linkId,
      taskId,
      linkedTaskId,
      kind,
      createdBy: actorMemberId,
    })
    .onConflictDoNothing();
  await logActivity(taskId, actorMemberId, "link_added", { linkedTaskId, kind });
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const [hydrated] = await hydrateTasks([row]);
  await publishToConversation(t.conversationId, {
    type: "task.updated",
    conversationId: t.conversationId,
    taskId,
    task: hydrated,
  });
  return { ok: true as const, linkId };
}

export async function removeLink(taskId: string, linkId: string, actorMemberId: string) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  await db.delete(taskLinks).where(and(eq(taskLinks.id, linkId), eq(taskLinks.taskId, taskId)));
  await logActivity(taskId, actorMemberId, "link_removed", { linkId });
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const [hydrated] = await hydrateTasks([row]);
  await publishToConversation(t.conversationId, {
    type: "task.updated",
    conversationId: t.conversationId,
    taskId,
    task: hydrated,
  });
  return { ok: true as const };
}

export async function addComment(
  taskId: string,
  bodyMd: string,
  mentions: string[],
  actorMemberId: string,
) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  const commentId = id("tcom");
  const cleanMentions = Array.from(new Set(mentions ?? []));
  await db.insert(taskComments).values({
    id: commentId,
    taskId,
    memberId: actorMemberId,
    bodyMd,
    mentions: cleanMentions,
  });
  await logActivity(taskId, actorMemberId, "comment", { commentId });
  const [row] = await db.select().from(taskComments).where(eq(taskComments.id, commentId));
  await publishToConversation(t.conversationId, {
    type: "task.comment.new",
    conversationId: t.conversationId,
    taskId,
    comment: row,
  });
  const assignees = await db
    .select({ memberId: taskAssignees.memberId })
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, taskId));
  const wake = new Set<string>([...cleanMentions, ...assignees.map((a) => a.memberId)]);
  wake.delete(actorMemberId);
  for (const mid of wake) {
    await maybeFireAgentTrigger(mid, taskId, t.conversationId, "task_comment");
  }
  return { comment: row };
}

export async function deleteComment(taskId: string, commentId: string, actorMemberId: string) {
  const t = await loadTask(taskId);
  if (!t) return { error: "not_found" as const };
  if (!(await assertConvMember(t.conversationId, actorMemberId))) return { error: "not_a_member" as const };
  const [c] = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, taskId)))
    .limit(1);
  if (!c) return { error: "comment_not_found" as const };
  if (c.memberId !== actorMemberId) return { error: "not_author" as const };
  await db.update(taskComments).set({ deletedAt: new Date() }).where(eq(taskComments.id, commentId));
  await publishToConversation(t.conversationId, {
    type: "task.comment.deleted",
    conversationId: t.conversationId,
    taskId,
    commentId,
  });
  return { ok: true as const };
}
