import { FastifyInstance } from "fastify";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  agentRuns,
  approvals,
  members,
  messages,
  taskActivity,
  taskAssignees,
  taskComments,
  tasks,
  users,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";

// Read-only aggregation over data the platform already records — agent_runs,
// the task_activity audit trail, messages/comments — answering "what are the
// agents doing and how much are they shipping?". One endpoint, one payload:
// the roster is a handful of agents, so we aggregate in a few small queries
// and assemble in JS instead of building a query per widget.

const RANGES = new Set([7, 30, 90]);

export default async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/analytics", async (req) => {
    const { workspaceId } = req.auth!;
    const q = req.query as { days?: string };
    const days = RANGES.has(Number(q.days)) ? Number(q.days) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // ── roster ──
    const roster = await db
      .select({
        id: agents.id,
        name: agents.name,
        handle: agents.handle,
        avatarColor: agents.avatarColor,
        status: agents.status,
        title: agents.title,
      })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId!));
    const agentIds = roster.map((a) => a.id);

    // Agent member rows (actor ids for activity attribution).
    const agentMembers = agentIds.length
      ? await db
          .select({ id: members.id, refId: members.refId })
          .from(members)
          .where(
            and(
              eq(members.workspaceId, workspaceId!),
              eq(members.kind, "agent"),
              inArray(members.refId, agentIds),
            ),
          )
      : [];
    const agentIdByMember = new Map(agentMembers.map((m) => [m.id, m.refId]));
    const memberIdByAgent = new Map(agentMembers.map((m) => [m.refId, m.id]));

    // ── task completions: every status→done flip in range, with actor kind ──
    // Volume is small (a workspace's done-flips over ≤90 days), so we pull the
    // rows and derive per-agent counts, the daily series, human totals, and
    // the recent-completions feed from one result set.
    const doneFlips = await db
      .select({
        taskId: taskActivity.taskId,
        actorMemberId: taskActivity.actorMemberId,
        actorKind: members.kind,
        ts: taskActivity.ts,
      })
      .from(taskActivity)
      .innerJoin(members, eq(members.id, taskActivity.actorMemberId))
      .innerJoin(tasks, eq(tasks.id, taskActivity.taskId))
      .where(
        and(
          eq(tasks.workspaceId, workspaceId!),
          eq(taskActivity.kind, "status_changed"),
          sql`${taskActivity.payload}->>'to' = 'done'`,
          gte(taskActivity.ts, since),
        ),
      )
      .orderBy(taskActivity.ts);

    // A task re-flipped to done counts once, credited to its LATEST flipper.
    const latestFlipByTask = new Map<string, (typeof doneFlips)[number]>();
    for (const f of doneFlips) latestFlipByTask.set(f.taskId, f);
    const completions = Array.from(latestFlipByTask.values());

    const completedByAgent = new Map<string, number>();
    let completedByHumans = 0;
    const seriesByDate = new Map<string, Record<string, number>>();
    for (const f of completions) {
      const agentId = agentIdByMember.get(f.actorMemberId);
      if (agentId) {
        completedByAgent.set(agentId, (completedByAgent.get(agentId) ?? 0) + 1);
        const date = f.ts.toISOString().slice(0, 10);
        const bucket = seriesByDate.get(date) ?? {};
        bucket[agentId] = (bucket[agentId] ?? 0) + 1;
        seriesByDate.set(date, bucket);
      } else if (f.actorKind === "user") {
        completedByHumans++;
      }
    }

    // ── open workload per agent (assigned, not archived, not done) ──
    const agentMemberIds = agentMembers.map((m) => m.id);
    const openRows = agentMemberIds.length
      ? await db
          .select({ memberId: taskAssignees.memberId, status: tasks.status })
          .from(taskAssignees)
          .innerJoin(tasks, eq(tasks.id, taskAssignees.taskId))
          .where(
            and(
              inArray(taskAssignees.memberId, agentMemberIds),
              eq(tasks.archived, false),
              sql`${tasks.status} <> 'done'`,
            ),
          )
      : [];
    const openByAgent = new Map<string, { backlog: number; in_progress: number; review: number }>();
    for (const r of openRows) {
      const agentId = agentIdByMember.get(r.memberId);
      if (!agentId) continue;
      const o = openByAgent.get(agentId) ?? { backlog: 0, in_progress: 0, review: 0 };
      if (r.status === "backlog" || r.status === "in_progress" || r.status === "review") o[r.status]++;
      openByAgent.set(agentId, o);
    }

    // ── runs: grouped by agent × status × trigger, with applied/error sums ──
    const runRows = agentIds.length
      ? await db
          .select({
            agentId: agentRuns.agentId,
            status: agentRuns.status,
            trigger: agentRuns.trigger,
            n: sql<number>`count(*)::int`,
            applied: sql<number>`coalesce(sum((${agentRuns.resultJson}->>'applied')::int), 0)::int`,
            withErrors: sql<number>`count(*) filter (where jsonb_array_length(coalesce(${agentRuns.resultJson}->'errors', '[]'::jsonb)) > 0)::int`,
            skipped: sql<number>`count(*) filter (where ${agentRuns.resultJson}->>'skipped' is not null)::int`,
            durSec: sql<number>`coalesce(sum(extract(epoch from (${agentRuns.finishedAt} - ${agentRuns.startedAt}))) filter (where ${agentRuns.finishedAt} is not null), 0)::float`,
            nFinished: sql<number>`count(*) filter (where ${agentRuns.finishedAt} is not null)::int`,
            lastFinished: sql<string | null>`max(${agentRuns.finishedAt})`,
          })
          .from(agentRuns)
          .where(and(inArray(agentRuns.agentId, agentIds), gte(agentRuns.startedAt, since)))
          .groupBy(agentRuns.agentId, agentRuns.status, agentRuns.trigger)
      : [];
    type RunAgg = {
      total: number;
      ok: number;
      failed: number;
      byTrigger: Record<string, number>;
      actionsApplied: number;
      runsWithErrors: number;
      skippedRuns: number;
      durSec: number;
      nFinished: number;
      lastActiveAt: string | null;
    };
    const runsByAgent = new Map<string, RunAgg>();
    for (const r of runRows) {
      const agg =
        runsByAgent.get(r.agentId) ??
        { total: 0, ok: 0, failed: 0, byTrigger: {}, actionsApplied: 0, runsWithErrors: 0, skippedRuns: 0, durSec: 0, nFinished: 0, lastActiveAt: null };
      agg.total += r.n;
      if (r.status === "ok") agg.ok += r.n;
      if (r.status === "failed") agg.failed += r.n;
      agg.byTrigger[r.trigger] = (agg.byTrigger[r.trigger] ?? 0) + r.n;
      agg.actionsApplied += r.applied;
      agg.runsWithErrors += r.withErrors;
      agg.skippedRuns += r.skipped;
      agg.durSec += r.durSec;
      agg.nFinished += r.nFinished;
      if (r.lastFinished && (!agg.lastActiveAt || r.lastFinished > agg.lastActiveAt)) {
        agg.lastActiveAt = r.lastFinished;
      }
      runsByAgent.set(r.agentId, agg);
    }

    // ── error taxonomy: every run-error string in range, normalized so the
    // same failure with different ids buckets together ("post_message
    // rejected: tool_call_syntax", "share_to_task task_<id>: not_found", …).
    // Errors are sparse relative to runs, so unnesting is cheap.
    const errRows = agentIds.length
      ? ((await db.execute(sql`
          select r.agent_id as agent_id, e.value as err
          from agent_runs r
          cross join lateral jsonb_array_elements_text(coalesce(r.result_json->'errors', '[]'::jsonb)) e
          where r.agent_id in (${sql.join(agentIds.map((x) => sql`${x}`), sql`, `)})
            and r.started_at >= ${since.toISOString()}::timestamptz
        `)) as unknown as Array<{ agent_id: string; err: string }>)
      : [];
    const handleByAgentId = new Map(roster.map((a) => [a.id, a.handle]));
    const errBuckets = new Map<string, { count: number; agents: Set<string> }>();
    for (const r of errRows) {
      const reason = r.err
        .replace(/\b(task|goal|ap|run|act|c|m|w|u|msg|cm)_[a-z0-9]+\b/g, "<id>")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      const b = errBuckets.get(reason) ?? { count: 0, agents: new Set<string>() };
      b.count++;
      const h = handleByAgentId.get(r.agent_id);
      if (h) b.agents.add(h);
      errBuckets.set(reason, b);
    }
    const topErrors = Array.from(errBuckets.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([reason, b]) => ({ reason, count: b.count, agents: Array.from(b.agents) }));

    // ── chat + comment volume in range ──
    const msgRows = agentMemberIds.length
      ? await db
          .select({ memberId: messages.memberId, n: sql<number>`count(*)::int` })
          .from(messages)
          .where(
            and(
              inArray(messages.memberId, agentMemberIds),
              gte(messages.ts, since),
              isNull(messages.deletedAt),
            ),
          )
          .groupBy(messages.memberId)
      : [];
    const msgsByAgent = new Map(
      msgRows.map((r) => [agentIdByMember.get(r.memberId)!, r.n]),
    );
    const commentRows = agentMemberIds.length
      ? await db
          .select({ memberId: taskComments.memberId, n: sql<number>`count(*)::int` })
          .from(taskComments)
          .where(
            and(
              inArray(taskComments.memberId, agentMemberIds),
              gte(taskComments.ts, since),
              isNull(taskComments.deletedAt),
            ),
          )
          .groupBy(taskComments.memberId)
      : [];
    const commentsByAgent = new Map(
      commentRows.map((r) => [agentIdByMember.get(r.memberId)!, r.n]),
    );

    // ── pending approvals per agent ──
    const apRows = agentIds.length
      ? await db
          .select({ agentId: approvals.agentId, n: sql<number>`count(*)::int` })
          .from(approvals)
          .where(and(inArray(approvals.agentId, agentIds), eq(approvals.status, "pending")))
          .groupBy(approvals.agentId)
      : [];
    const approvalsByAgent = new Map(apRows.map((r) => [r.agentId, r.n]));

    // ── recent completions feed (latest first, with titles + actor handles) ──
    const recent = completions
      .sort((a, b) => +b.ts - +a.ts)
      .slice(0, 15);
    const recentTaskIds = recent.map((r) => r.taskId);
    const titleRows = recentTaskIds.length
      ? await db
          .select({ id: tasks.id, title: tasks.title })
          .from(tasks)
          .where(inArray(tasks.id, recentTaskIds))
      : [];
    const titleById = new Map(titleRows.map((t) => [t.id, t.title]));
    // Resolve actor handles (agents from the roster; humans via users).
    const handleByMember = new Map<string, { handle: string; kind: string }>();
    for (const m of agentMembers) {
      const a = roster.find((x) => x.id === m.refId);
      if (a) handleByMember.set(m.id, { handle: a.handle, kind: "agent" });
    }
    const humanMemberIds = Array.from(
      new Set(recent.map((r) => r.actorMemberId).filter((id) => !handleByMember.has(id))),
    );
    if (humanMemberIds.length) {
      const rows = await db
        .select({ memberId: members.id, handle: users.handle })
        .from(members)
        .innerJoin(users, eq(users.id, members.refId))
        .where(and(inArray(members.id, humanMemberIds), eq(members.kind, "user")));
      for (const r of rows) handleByMember.set(r.memberId, { handle: r.handle, kind: "user" });
    }

    // ── workspace totals ──
    const [openTotal] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(eq(tasks.workspaceId, workspaceId!), eq(tasks.archived, false), sql`${tasks.status} <> 'done'`),
      );

    const agentsOut = roster
      .map((a) => {
        const runs = runsByAgent.get(a.id);
        return {
          id: a.id,
          name: a.name,
          handle: a.handle,
          avatarColor: a.avatarColor,
          status: a.status,
          title: a.title,
          lastActiveAt: runs?.lastActiveAt ?? null,
          tasksCompleted: completedByAgent.get(a.id) ?? 0,
          tasksOpen: openByAgent.get(a.id) ?? { backlog: 0, in_progress: 0, review: 0 },
          runs: {
            total: runs?.total ?? 0,
            ok: runs?.ok ?? 0,
            failed: runs?.failed ?? 0,
            byTrigger: runs?.byTrigger ?? {},
          },
          actionsApplied: runs?.actionsApplied ?? 0,
          runsWithErrors: runs?.runsWithErrors ?? 0,
          skippedRuns: runs?.skippedRuns ?? 0,
          avgRunSec: runs && runs.nFinished > 0 ? Math.round(runs.durSec / runs.nFinished) : 0,
          messages: msgsByAgent.get(a.id) ?? 0,
          taskComments: commentsByAgent.get(a.id) ?? 0,
          approvalsPending: approvalsByAgent.get(a.id) ?? 0,
        };
      })
      .sort((x, y) => y.tasksCompleted - x.tasksCompleted || y.actionsApplied - x.actionsApplied);

    // Dense daily series over the whole range so the chart has even spacing.
    const series: Array<{ date: string; byAgent: Record<string, number> }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      series.push({ date, byAgent: seriesByDate.get(date) ?? {} });
    }

    const agentCompleted = agentsOut.reduce((s, a) => s + a.tasksCompleted, 0);
    return {
      days,
      agents: agentsOut,
      series,
      totals: {
        tasksCompleted: agentCompleted,
        tasksCompletedByHumans: completedByHumans,
        actionsApplied: agentsOut.reduce((s, a) => s + a.actionsApplied, 0),
        runs: agentsOut.reduce((s, a) => s + a.runs.total, 0),
        failedRuns: agentsOut.reduce((s, a) => s + a.runs.failed, 0),
        openTasks: openTotal?.n ?? 0,
      },
      topErrors,
      recentCompletions: recent.map((r) => {
        const who = handleByMember.get(r.actorMemberId);
        return {
          taskId: r.taskId,
          title: titleById.get(r.taskId) ?? "(deleted task)",
          byHandle: who?.handle ?? "unknown",
          byKind: who?.kind ?? "unknown",
          ts: r.ts.toISOString(),
        };
      }),
    };
  });
}
