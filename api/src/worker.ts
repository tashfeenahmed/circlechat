import { Worker } from "bullmq";
import { eq, desc, and, ne } from "drizzle-orm";
import { AGENT_QUEUE, type AgentJobPayload } from "./agents/queue.js";
import { redis } from "./lib/redis.js";
import { db } from "./db/index.js";
import { agents, agentRuns } from "./db/schema.js";
import { buildContext } from "./agents/context.js";
import { callAgent } from "./agents/adapters/dispatch.js";
import { applyActions, type AgentAction } from "./agents/executor.js";
import { materialiseScheduledRun } from "./agents/scheduler.js";
import { publishToConversation, publishGlobal } from "./lib/events.js";

const worker = new Worker<AgentJobPayload>(
  AGENT_QUEUE,
  async (job) => {
    const payload = job.data;
    // Scheduled jobs don't carry a runId (repeatable job template) — materialise one.
    let runId = payload.runId;
    if (payload.trigger === "scheduled" && !runId) runId = await materialiseScheduledRun(payload.agentId);

    const [agent] = await db.select().from(agents).where(eq(agents.id, payload.agentId)).limit(1);
    if (!agent) {
      await db
        .update(agentRuns)
        .set({ status: "failed", errorText: "agent_missing", finishedAt: new Date() })
        .where(eq(agentRuns.id, runId));
      return;
    }
    if (agent.status === "paused") {
      await db
        .update(agentRuns)
        .set({ status: "ok", resultJson: { skipped: "paused" }, finishedAt: new Date() })
        .where(eq(agentRuns.id, runId));
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
    await emitFinished(agent.id, runId, "ok", payload.conversationId);
  },
  { connection: redis, concurrency: 10, lockDuration: 120_000 },
);

async function emitFinished(
  agentId: string,
  runId: string,
  status: string,
  conversationId?: string | null,
): Promise<void> {
  if (conversationId) {
    await publishToConversation(conversationId, {
      type: "agent.run.finished",
      agentId,
      runId,
      status,
      conversationId,
    });
  } else {
    await publishGlobal({
      type: "agent.run.finished",
      agentId,
      runId,
      status,
      conversationId: null,
    });
  }
}

worker.on("error", (e) => console.error("[worker] error", e));
worker.on("failed", (job, err) => console.error("[worker] job failed", job?.id, err?.message));

console.log(`[worker] circlechat agent-runs worker up, concurrency=10`);
