import { Worker } from "bullmq";
import { eq, desc, and, ne } from "drizzle-orm";
import { AGENT_QUEUE, type AgentJobPayload } from "./agents/queue.js";
import { redis } from "./lib/redis.js";
import { db } from "./db/index.js";
import { agents, agentRuns } from "./db/schema.js";
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
  { connection: redis, concurrency: 10, lockDuration: 120_000 },
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

worker.on("error", (e) => console.error("[worker] error", e));
worker.on("failed", (job, err) => console.error("[worker] job failed", job?.id, err?.message));

console.log(`[worker] circlechat agent-runs worker up, concurrency=10`);
