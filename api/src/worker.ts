import { Worker } from "bullmq";
import { eq, desc, and, ne, gt, sql, inArray } from "drizzle-orm";
import { AGENT_QUEUE, type AgentJobPayload } from "./agents/queue.js";
import { redis } from "./lib/redis.js";
import { db } from "./db/index.js";
import {
  agents,
  agentRuns,
  members,
  conversationMembers,
  messages,
  tasks,
  taskComments,
  taskAssignees,
} from "./db/schema.js";
import { buildContext } from "./agents/context.js";
import { callAgent } from "./agents/adapters/dispatch.js";
import { applyActions, type AgentAction } from "./agents/executor.js";
import { materialiseScheduledRun, cancelAgentHeartbeat } from "./agents/scheduler.js";
import { publishToConversation, publishGlobal } from "./lib/events.js";

const worker = new Worker<AgentJobPayload>(
  AGENT_QUEUE,
  async (job) => {
    const payload = job.data;

    // Check the agent exists BEFORE materialising the run or emitting any
    // WS frames. Otherwise a stale repeatable heartbeat (left in Redis after
    // the agent row was deleted) would emit a ghost `agent.run.started` pill
    // on every tick. Self-heal by cancelling the repeat.
    const [agent] = await db.select().from(agents).where(eq(agents.id, payload.agentId)).limit(1);
    if (!agent) {
      if (payload.trigger === "scheduled") {
        try { await cancelAgentHeartbeat(payload.agentId); } catch { /* ignore */ }
      }
      // If the enqueuer already minted a runId (event trigger), close it so
      // the UI pill clears immediately.
      if (payload.runId) {
        await db
          .update(agentRuns)
          .set({ status: "failed", errorText: "agent_missing", finishedAt: new Date() })
          .where(eq(agentRuns.id, payload.runId));
        await emitFinished(payload.agentId, payload.runId, "failed", payload.conversationId);
      }
      return;
    }

    // Scheduled jobs don't carry a runId (repeatable job template) — materialise one.
    let runId = payload.runId;
    if (payload.trigger === "scheduled" && !runId) runId = await materialiseScheduledRun(payload.agentId);

    if (agent.status === "paused") {
      await db
        .update(agentRuns)
        .set({ status: "ok", resultJson: { skipped: "paused" }, finishedAt: new Date() })
        .where(eq(agentRuns.id, runId));
      await emitFinished(agent.id, runId, "ok", payload.conversationId);
      return;
    }

    await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, runId));
    await db.update(agents).set({ status: "working" }).where(eq(agents.id, agent.id));
    if (payload.conversationId) {
      await publishToConversation(payload.conversationId, {
        type: "agent.run.started",
        agentId: agent.id,
        agentName: agent.name,
        agentHandle: agent.handle,
        runId,
        trigger: payload.trigger,
        conversationId: payload.conversationId,
      });
    } else {
      await publishGlobal({
        type: "agent.run.started",
        agentId: agent.id,
        agentName: agent.name,
        agentHandle: agent.handle,
        runId,
        trigger: payload.trigger,
        conversationId: null,
      });
    }

    // Build context packet: last-beat cursor is the previous run's startedAt.
    const prevRuns = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agent.id), ne(agentRuns.id, runId)))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    const sinceTs =
      prevRuns[0]?.finishedAt ?? prevRuns[0]?.startedAt ?? new Date(Date.now() - 1000 * 60 * 60);

    // Activity gate for scheduled heartbeats: if nothing has changed in the
    // agent's channels or open tasks since their last run, skip the LLM call
    // entirely. Most scheduled runs fire into a quiet workspace and produce
    // filler — this is the cheapest, highest-impact way to cut that noise.
    if (payload.trigger === "scheduled") {
      const idle = await isWorkspaceIdleForAgent(agent.id, sinceTs);
      if (idle) {
        await db
          .update(agentRuns)
          .set({
            status: "ok",
            resultJson: { skipped: "no_activity" },
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, runId));
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
        await emitFinished(agent.id, runId, "ok", payload.conversationId);
        return;
      }
    }

    const packet = await buildContext({
      agentId: agent.id,
      trigger: payload.trigger,
      sinceTs,
      untilTs: new Date(),
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      taskId: payload.taskId,
    });
    await db.update(agentRuns).set({ contextJson: packet as never }).where(eq(agentRuns.id, runId));

    const kind: "heartbeat" | "event" =
      payload.trigger === "scheduled" || payload.trigger === "ambient" ? "heartbeat" : "event";

    let response: Awaited<ReturnType<typeof callAgent>>;
    try {
      response = await callAgent(agent, kind, packet);
    } catch (e) {
      await db
        .update(agentRuns)
        .set({
          status: "failed",
          errorText: (e as Error).message,
          finishedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      await db.update(agents).set({ status: "error" }).where(eq(agents.id, agent.id));
      await emitFinished(agent.id, runId, "failed", payload.conversationId);
      throw e;
    }

    let actions: AgentAction[] = [];
    let trace: string[] = [];
    if (response === "HEARTBEAT_OK") {
      // silent no-op
    } else {
      actions = (response.actions as AgentAction[]) ?? [];
      trace = response.trace ?? [];
    }

    const outcome = await applyActions({ agentId: agent.id, runId, actions });

    await db
      .update(agentRuns)
      .set({
        status: "ok",
        resultJson: { applied: outcome.actionsApplied, errors: outcome.errors },
        traceJson: [...trace, ...outcome.trace],
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
    await emitFinished(agent.id, runId, "ok", payload.conversationId, {
      agentName: agent.name,
      agentHandle: agent.handle,
      errors: outcome.errors,
    });
  },
  { connection: redis, concurrency: 10, lockDuration: 240_000 },
);

async function emitFinished(
  agentId: string,
  runId: string,
  status: string,
  conversationId?: string | null,
  extra?: { agentName?: string; agentHandle?: string; errors?: string[] },
): Promise<void> {
  const base = {
    type: "agent.run.finished" as const,
    agentId,
    runId,
    status,
    ...(extra?.agentName ? { agentName: extra.agentName } : {}),
    ...(extra?.agentHandle ? { agentHandle: extra.agentHandle } : {}),
    ...(extra?.errors && extra.errors.length ? { errors: extra.errors } : {}),
  };
  if (conversationId) {
    await publishToConversation(conversationId, { ...base, conversationId });
  } else {
    await publishGlobal({ ...base, conversationId: null });
  }
}

// Decide whether to skip a scheduled heartbeat. The bar is "this agent has
// nothing they could plausibly work on right now" — which means BOTH:
//   1. No new external activity since their last run (msgs/comments/assignments), AND
//   2. No open assigned tasks that are stale (task they own, status not done/cancelled,
//      no comment from them in the last STALE_TASK_MS).
//
// Open assigned tasks are work-in-progress and the whole point of heartbeats
// is for agents to iterate on them proactively — never skip a heartbeat just
// because no human pinged them, if they have a task that needs the next step.
const STALE_TASK_MS = 10 * 60 * 1000; // 10 min: time without agent's own comment that re-qualifies the task as "needs a progress beat"

async function isWorkspaceIdleForAgent(agentId: string, sinceTs: Date): Promise<boolean> {
  const [agentMember] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, agentId)))
    .limit(1);
  if (!agentMember) return false;

  const memberConvs = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.memberId, agentMember.id));
  const convIds = memberConvs.map((c) => c.conversationId);

  if (convIds.length > 0) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(inArray(messages.conversationId, convIds), gt(messages.ts, sinceTs)));
    if (n > 0) return false;
  }

  // Open tasks assigned to me — these are the "proactive work" reason to fire.
  const myOpenTasks = await db
    .select({ taskId: tasks.id, status: tasks.status, updatedAt: tasks.updatedAt })
    .from(tasks)
    .innerJoin(taskAssignees, eq(taskAssignees.taskId, tasks.id))
    .where(
      and(
        eq(taskAssignees.memberId, agentMember.id),
        eq(tasks.archived, false),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ),
    );

  if (myOpenTasks.length > 0) {
    const myTaskIds = myOpenTasks.map((t) => t.taskId);

    // Any new external comment on these tasks since last run? Wake.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(taskComments)
      .where(and(inArray(taskComments.taskId, myTaskIds), gt(taskComments.ts, sinceTs)));
    if (n > 0) return false;

    // Any task I own where MY OWN last comment is older than STALE_TASK_MS
    // (or I've never commented)? Wake — time to ship progress.
    const cutoff = new Date(Date.now() - STALE_TASK_MS);
    for (const t of myOpenTasks) {
      const [latestMine] = await db
        .select({ ts: taskComments.ts })
        .from(taskComments)
        .where(and(eq(taskComments.taskId, t.taskId), eq(taskComments.memberId, agentMember.id)))
        .orderBy(desc(taskComments.ts))
        .limit(1);
      const lastTouch = latestMine?.ts ?? t.updatedAt;
      if (lastTouch < cutoff) return false;
    }
  }

  // New assignments to this agent (since last run) are activity worth waking for.
  const [{ n: na }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(taskAssignees)
    .where(and(eq(taskAssignees.memberId, agentMember.id), gt(taskAssignees.assignedAt, sinceTs)));
  if (na > 0) return false;

  return true;
}

worker.on("error", (e) => console.error("[worker] error", e));
worker.on("failed", (job, err) => console.error("[worker] job failed", job?.id, err?.message));

console.log(`[worker] circlechat agent-runs worker up, concurrency=10`);
