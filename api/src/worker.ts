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
  boardStages,
} from "./db/schema.js";
import { buildContext } from "./agents/context.js";
import { callAgent } from "./agents/adapters/dispatch.js";
import { applyActions, type AgentAction } from "./agents/executor.js";
import {
  materialiseScheduledRun,
  cancelAgentHeartbeat,
  noteHeartbeatOutcome,
  heartbeatBackoffRemainingMs,
} from "./agents/scheduler.js";
import { classifyRunOutcome } from "./lib/run-outcome.js";
import { publishToConversation, publishGlobal } from "./lib/events.js";
import { exportRunTrace } from "./lib/tracing.js";
import { enforceBudgets, estimateRunCost } from "./lib/budgets.js";
import { enqueueAgentEvent } from "./agents/enqueue.js";
import { continuationEnabled, shouldContinue } from "./agents/continuation.js";
import {
  detectStuck,
  normalizeRunSignature,
  stuckBreakDirective,
} from "./lib/stuck-detector.js";

const STUCK_BREAK_TTL_MS = 2 * 60 * 60 * 1000;
const stuckKey = (agentId: string) => `cc:stuckbreak:${agentId}`;

// Read + clear the one-shot loop-break directive left by a prior run.
async function consumeStuckBreak(agentId: string): Promise<string | null> {
  try {
    const v = await redis.getdel(stuckKey(agentId));
    return v || null;
  } catch {
    return null;
  }
}

// Read + clear the one-shot run_code output left by a prior run (sandbox runs
// after the LLM turn, so its result is surfaced on the next turn).
async function consumeCodeResult(agentId: string): Promise<string | null> {
  try {
    const v = await redis.getdel(`cc:codeexec:${agentId}`);
    return v || null;
  } catch {
    return null;
  }
}

// After a run, fingerprint the agent's recent runs and flag a behavioral loop
// (repeat / A-B-A-B alternation) so the NEXT run is told to break it. Returns
// true when stuck so the caller also suppresses the continuation chain. Reads
// the runs newest-first then reverses to oldest→newest for the detector.
async function detectAndFlagStuck(agentId: string): Promise<boolean> {
  try {
    // Failed runs count too: a run that hit max-iterations or had every action
    // rejected three times in a row IS the loop — excluding them (as the old
    // status='ok' filter did once failures are recorded honestly) would blind
    // the detector to exactly the runs it exists for.
    const recent = await db
      .select({ resultJson: agentRuns.resultJson, traceJson: agentRuns.traceJson, errorText: agentRuns.errorText })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agentId), inArray(agentRuns.status, ["ok", "failed"])))
      .orderBy(desc(agentRuns.startedAt))
      .limit(4);
    const signatures = recent
      .reverse()
      .filter((r) => !(r.resultJson as { skipped?: unknown })?.skipped)
      .map((r) =>
        normalizeRunSignature(
          (r.traceJson as string[]) ?? [],
          [
            ...((((r.resultJson as { errors?: string[] })?.errors as string[]) ?? [])),
            ...(r.errorText ? [r.errorText] : []),
          ],
        ),
      );
    const verdict = detectStuck(signatures);
    if (!verdict.stuck) return false;
    await redis.set(stuckKey(agentId), stuckBreakDirective(verdict.pattern), "PX", STUCK_BREAK_TTL_MS);
    console.log(`[worker] stuck (${verdict.pattern}) agent=${agentId} :: ${verdict.signature.slice(0, 120)}`);
    return true;
  } catch (e) {
    console.error("[worker] stuck detection failed", (e as Error).message);
    return false;
  }
}
import { redactSecrets, redactLines } from "./lib/redaction.js";
import { startGoalPlanWorker } from "./agents/goal-planner-worker.js";
import { scheduleGoalSweep, scheduleMissionSweep } from "./lib/goal-queue.js";
import {
  modelRecommendation,
  recordModelUsage,
  refreshAgentRunUsage,
} from "./lib/model-usage-store.js";
import {
  resumeWorkflowFromAgent,
  startWorkflowWorker,
  workflowAgentContext,
} from "./lib/workflow-engine.js";

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
      if (payload.workflowRunId && payload.workflowStepId) {
        await resumeWorkflowFromAgent({
          workflowRunId: payload.workflowRunId,
          workflowStepId: payload.workflowStepId,
          success: false,
          output: {},
          errorText: "agent_missing",
        });
      }
      return;
    }

    // Scheduled jobs don't carry a runId (repeatable job template) — materialise one.
    let runId = payload.runId;
    if (payload.trigger === "scheduled" && !runId) runId = await materialiseScheduledRun(payload.agentId);

    const [controlAtStart] = await db.select({
      status: agentRuns.status,
      cancelRequestedAt: agentRuns.cancelRequestedAt,
      timeoutAt: agentRuns.timeoutAt,
    }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (
      !controlAtStart || controlAtStart.status === "cancelled" || controlAtStart.cancelRequestedAt ||
      (controlAtStart.timeoutAt && controlAtStart.timeoutAt <= new Date())
    ) {
      if (controlAtStart && controlAtStart.status !== "cancelled") {
        await db.update(agentRuns).set({ status: "cancelled", errorText: "run_timeout", finishedAt: new Date() }).where(eq(agentRuns.id, runId));
      }
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
      await emitFinished(agent.id, runId, "cancelled", payload.conversationId);
      return;
    }

    if (agent.status === "paused") {
      await db
        .update(agentRuns)
        .set({ status: "ok", resultJson: { skipped: "paused" }, finishedAt: new Date() })
        .where(eq(agentRuns.id, runId));
      await emitFinished(agent.id, runId, "ok", payload.conversationId);
      if (payload.workflowRunId && payload.workflowStepId) {
        await resumeWorkflowFromAgent({
          workflowRunId: payload.workflowRunId,
          workflowStepId: payload.workflowStepId,
          success: false,
          output: { skipped: "paused" },
          errorText: "agent_paused",
        });
      }
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
      const wake = await wakeReasonForAgent(agent.id, sinceTs);
      if (!wake) {
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
      // Non-productive-streak backoff. Only the self-generated "progress beat"
      // reason is suppressed — a human message/comment/assignment always wakes.
      if (wake === "stale_task") {
        const remaining = await heartbeatBackoffRemainingMs(agent.id);
        if (remaining > 0) {
          await db
            .update(agentRuns)
            .set({
              status: "ok",
              resultJson: { skipped: "heartbeat_backoff", remainingMs: remaining },
              finishedAt: new Date(),
            })
            .where(eq(agentRuns.id, runId));
          await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
          await emitFinished(agent.id, runId, "ok", payload.conversationId);
          return;
        }
      }
    }

    // Budget gate: month-to-date estimated spend vs the agent's and the
    // workspace's monthly caps. A hard stop pauses the agent (agent scope) or
    // skips every run (workspace scope) until a human raises the cap.
    const gate = await enforceBudgets(agent);
    if (!gate.allowed) {
      await db
        .update(agentRuns)
        .set({
          status: "ok",
          resultJson: { skipped: gate.reason },
          finishedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      if (gate.reason === "agent_budget") {
        // enforceBudgets already set status=paused + pause_reason='budget';
        // drop the repeatable heartbeat too so the queue stays quiet (resume
        // re-schedules it).
        try { await cancelAgentHeartbeat(agent.id); } catch { /* ignore */ }
      } else {
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
      }
      await emitFinished(agent.id, runId, "ok", payload.conversationId);
      if (payload.workflowRunId && payload.workflowStepId) {
        await resumeWorkflowFromAgent({
          workflowRunId: payload.workflowRunId,
          workflowStepId: payload.workflowStepId,
          success: false,
          output: { skipped: gate.reason },
          errorText: gate.reason,
        });
      }
      return;
    }

    // One-shot loop-break directive: if the previous run detected this agent in
    // a behavioral loop, it left a flag; consume it so this run gets told to
    // break the pattern (and the flag clears so it's a nudge, not a wall).
    const stuckBreak = await consumeStuckBreak(agent.id);
    const lastCodeResult = await consumeCodeResult(agent.id);

    const packet = await buildContext({
      agentId: agent.id,
      trigger: payload.trigger,
      sinceTs,
      untilTs: new Date(),
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      taskId: payload.taskId,
      approvalId: payload.approvalId,
      previousRunFailure:
        prevRuns[0]?.status === "failed" && prevRuns[0].errorText
          ? {
              errorText: prevRuns[0].errorText,
              finishedAt: prevRuns[0].finishedAt?.toISOString() ?? null,
            }
          : null,
      previousRunErrors: (() => {
        const errs = (prevRuns[0]?.resultJson as { errors?: unknown } | null | undefined)?.errors;
        return Array.isArray(errs) ? errs.filter((e): e is string => typeof e === "string" && e.length > 0) : null;
      })(),
      stuckBreak,
      lastCodeResult,
      steering: payload.status ?? null,
    });
    packet.modelRoute = await modelRecommendation({
      workspaceId: agent.workspaceId,
      trigger: payload.trigger,
      text: payload.status ?? "",
    });
    if (payload.workflowRunId) {
      const workflow = await workflowAgentContext(payload.workflowRunId);
      if (workflow) packet.workflow = workflow;
    }
    const [runControls] = await db.select({ steer: agentRuns.steerJson, followUps: agentRuns.followupJson, timeoutAt: agentRuns.timeoutAt })
      .from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (runControls) packet.runControls = runControls;
    if (payload.stageExecution) {
      packet.stageExecution = payload.stageExecution;
    } else if (payload.taskId) {
      const [taskStage] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, payload.taskId)).limit(1);
      if (taskStage) {
        const [stage] = await db.select().from(boardStages).where(and(eq(boardStages.workspaceId, agent.workspaceId), eq(boardStages.stage, taskStage.status))).limit(1);
        if (stage) packet.stageExecution = {
          stage: stage.stage,
          title: stage.title,
          instructions: stage.instructions,
          skill: stage.skill,
          verification: stage.verification,
          nextStage: stage.nextStage,
        };
      }
    }
    await db.update(agentRuns).set({ contextJson: packet as never }).where(eq(agentRuns.id, runId));

    const kind: "heartbeat" | "event" =
      payload.trigger === "scheduled" ||
      payload.trigger === "ambient" ||
      payload.trigger === "continuation"
        ? "heartbeat"
        : "event";

    const promptChars = JSON.stringify(packet).length;

    let response: Awaited<ReturnType<typeof callAgent>>;
    try {
      response = await callAgent(agent, kind, packet);
    } catch (e) {
      const { tokensEst, costUsd } = estimateRunCost(promptChars, 0);
      await recordModelUsage({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        runId,
        routeTier: packet.modelRoute?.tier,
        usage: {
          provider: packet.modelRoute?.provider ?? undefined,
          model: (packet.modelRoute?.model ?? agent.model) || undefined,
          inputTokens: tokensEst,
          outputTokens: 0,
          costUsd,
        },
        source: "estimated",
        eventKey: "worker",
      }).catch((usageError) => console.error("[worker] usage record failed", usageError));
      await db
        .update(agentRuns)
        .set({
          status: "failed",
          errorText: redactSecrets((e as Error).message),
          tokensEst,
          costUsd,
          finishedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      // A gateway can report actual usage asynchronously before this retry
      // finishes. Re-apply reported aggregates after writing the fallback so
      // the late worker estimate never overwrites provider-grade accounting.
      await refreshAgentRunUsage(runId).catch((usageError) =>
        console.error("[worker] usage refresh failed", usageError),
      );
      await db.update(agents).set({ status: "error" }).where(eq(agents.id, agent.id));
      await emitFinished(agent.id, runId, "failed", payload.conversationId);
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt && payload.workflowRunId && payload.workflowStepId) {
        await resumeWorkflowFromAgent({
          workflowRunId: payload.workflowRunId,
          workflowStepId: payload.workflowStepId,
          success: false,
          output: {},
          errorText: redactSecrets((e as Error).message),
        });
      }
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

    // A cancel/timeout that landed while the remote model was working is a
    // hard action boundary: retain the remote response nowhere and never apply
    // its side effects. This is the enforceable interrupt point for webhook and
    // socket runtimes that cannot be synchronously aborted mid-request.
    const [controlBeforeApply] = await db.select({
      status: agentRuns.status,
      cancelRequestedAt: agentRuns.cancelRequestedAt,
      timeoutAt: agentRuns.timeoutAt,
    }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (
      !controlBeforeApply || controlBeforeApply.status === "cancelled" || controlBeforeApply.cancelRequestedAt ||
      (controlBeforeApply.timeoutAt && controlBeforeApply.timeoutAt <= new Date())
    ) {
      await db.update(agentRuns).set({
        status: "cancelled", errorText: controlBeforeApply?.cancelRequestedAt ? "cancelled_by_user" : "run_timeout",
        resultJson: { skipped: "cancelled_before_actions" }, finishedAt: new Date(),
      }).where(eq(agentRuns.id, runId));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
      await emitFinished(agent.id, runId, "cancelled", payload.conversationId);
      if (payload.workflowRunId && payload.workflowStepId) {
        await resumeWorkflowFromAgent({
          workflowRunId: payload.workflowRunId, workflowStepId: payload.workflowStepId,
          success: false, output: { skipped: "cancelled_before_actions" }, errorText: "agent_run_cancelled",
        });
      }
      return;
    }

    const outcome = await applyActions({
      agentId: agent.id,
      runId,
      actions,
      triggerConversationId: payload.conversationId ?? null,
    });

    const completionChars =
      response === "HEARTBEAT_OK"
        ? 0
        : JSON.stringify(actions).length + trace.join("\n").length;
    const estimated = estimateRunCost(promptChars, completionChars);
    // Split the estimate so output tokens are not recorded as 0 on every
    // estimated row (the runtime rarely reports usage inline).
    const estimatedInput = estimateRunCost(promptChars, 0).tokensEst;
    const estimatedOutput = Math.max(0, estimated.tokensEst - estimatedInput);
    let tokensEst = estimated.tokensEst;
    let costUsd = estimated.costUsd;
    if (response !== "HEARTBEAT_OK" && response.usage) {
      try {
        const actual = await recordModelUsage({
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          runId,
          routeTier: packet.modelRoute?.tier,
          usage: response.usage,
          source: "reported",
          eventKey: "worker",
        });
        tokensEst = actual.tokens;
        costUsd = actual.costUsd;
      } catch (usageError) {
        // Metering must not cause already-applied agent actions to retry.
        console.error("[worker] reported usage record failed", usageError);
      }
    } else {
      await recordModelUsage({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        runId,
        routeTier: packet.modelRoute?.tier,
        usage: {
          provider: packet.modelRoute?.provider ?? undefined,
          // Leave model undefined when only "auto" is known so the store can
          // resolve a real name from the route / agent install config.
          model: packet.modelRoute?.model ?? undefined,
          inputTokens: estimatedInput,
          outputTokens: estimatedOutput,
          costUsd: estimated.costUsd,
        },
        source: "estimated",
        eventKey: "worker",
      }).catch((usageError) => console.error("[worker] usage record failed", usageError));
    }

    // Honest run accounting: empty/crashed replies, bridge errors, runaway
    // max-iterations banners and "every action rejected" are FAILED runs, not
    // ok — the stuck detector, run reaper, previousRunFailure context and the
    // heartbeat backoff all key on this.
    const cls = classifyRunOutcome(response, outcome);
    if (cls.status === "failed") {
      console.warn(`[worker] run ${runId} agent=${agent.handle} trigger=${payload.trigger} failed: ${cls.errorText}`);
    }
    await db
      .update(agentRuns)
      .set({
        status: cls.status,
        errorText: cls.errorText ? redactSecrets(cls.errorText) : null,
        resultJson: {
          applied: outcome.actionsApplied,
          errors: redactLines(outcome.errors),
          ...(cls.status === "ok" && !cls.productive ? { idle: true } : {}),
        },
        traceJson: redactLines([...trace, ...outcome.trace]),
        tokensEst,
        costUsd,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
    await refreshAgentRunUsage(runId).catch((usageError) =>
      console.error("[worker] usage refresh failed", usageError),
    );
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
    await emitFinished(agent.id, runId, cls.status, payload.conversationId, {
      agentName: agent.name,
      agentHandle: agent.handle,
      errors: outcome.errors,
    });

    // Heartbeat-kind runs feed the per-agent non-productive streak; a productive
    // run of any kind resets it.
    if (payload.trigger === "scheduled" || payload.trigger === "ambient" || cls.productive) {
      const bo = await noteHeartbeatOutcome(agent.id, cls.productive, agent.heartbeatIntervalSec);
      if (bo.backoffMs > 0) {
        console.log(`[worker] agent=${agent.handle} non-productive streak=${bo.streak} → heartbeat backoff ${Math.round(bo.backoffMs / 60000)}m`);
      }
    }

    const [completedControls] = await db.select({ followUps: agentRuns.followupJson }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (completedControls?.followUps.length) {
      const followupText = completedControls.followUps
        .map((entry) => typeof entry.text === "string" ? entry.text : "")
        .filter(Boolean)
        .join("\n\n");
      if (followupText) {
        await enqueueAgentEvent(agent.id, {
          trigger: "continuation",
          conversationId: payload.conversationId ?? null,
          taskId: payload.taskId,
          status: `Human follow-up:\n${followupText}`,
          chainDepth: 0,
        }).catch((e) => console.error("[worker] queued follow-up failed", e));
      }
    }

    if (payload.workflowRunId && payload.workflowStepId) {
      await resumeWorkflowFromAgent({
        workflowRunId: payload.workflowRunId,
        workflowStepId: payload.workflowStepId,
        success: cls.status === "ok" && outcome.errors.length === 0,
        output: {
          actionsApplied: outcome.actionsApplied,
          errors: redactLines(outcome.errors),
          trace: redactLines([...trace, ...outcome.trace]),
        },
        ...(cls.errorText
          ? { errorText: cls.errorText.slice(0, 500) }
          : outcome.errors.length
            ? { errorText: outcome.errors.join("; ").slice(0, 500) }
            : {}),
      });
    }

    // Loop guard: detect a run-level behavioral loop and, if found, leave a
    // one-shot break directive for the next run AND suppress the continuation
    // chain (continuing a loop just spends more on the same dead end).
    const stuck = await detectAndFlagStuck(agent.id);

    // Grant an immediate follow-up turn if the agent just advanced the board
    // (or ran code whose result it needs to see) and we're under the chain cap.
    // Budget is re-checked at the top of the next run, so a continuation can't
    // outrun a hard stop.
    const ranCode = actions.some((x) => x.type === "run_code");
    if (payload.trigger !== "workflow" && !stuck && cls.status === "ok" && continuationEnabled() && response !== "HEARTBEAT_OK") {
      const chainDepth = payload.chainDepth ?? 0;
      if ((outcome.actionsApplied > 0 && shouldContinue(actions, chainDepth)) || (ranCode && chainDepth < 2)) {
        await enqueueAgentEvent(agent.id, {
          trigger: "continuation",
          conversationId: payload.conversationId ?? null,
          taskId: payload.taskId,
          chainDepth: chainDepth + 1,
        }).catch((e) => console.error("[worker] continuation enqueue failed", e));
      }
    }
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
  // Ship the finalized run to the standard tracing backend if configured. The
  // run row is already written by every caller before this fires, so it has the
  // final status/result/trace. Fire-and-forget — never blocks the WS frame.
  void exportRunTrace(agentId, runId);
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
// Time without the agent's own comment that re-qualifies an in-flight task as
// "needs a progress beat". Configurable; 10 min default keeps existing cadence,
// the non-productive backoff (scheduler.ts) is what stops it churning.
const STALE_TASK_MS = Number(process.env.CC_STALE_TASK_MS ?? 10 * 60 * 1000);

// Why a scheduled heartbeat should run, or null = nothing to do (skip).
//   human_message   — a HUMAN posted in one of the agent's conversations
//   human_comment   — a HUMAN commented on one of the agent's open tasks
//   new_assignment  — the agent was assigned a task
//   stale_task      — the agent owns an in-flight task it hasn't touched lately
// Only stale_task is self-generated work; it is the one reason the
// non-productive backoff may suppress.
type WakeReason = "human_message" | "human_comment" | "new_assignment" | "stale_task";

async function wakeReasonForAgent(agentId: string, sinceTs: Date): Promise<WakeReason | null> {
  const [agentMember] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, agentId)))
    .limit(1);
  if (!agentMember) return "human_message"; // unknown membership: don't gate

  const memberConvs = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.memberId, agentMember.id));
  const convIds = memberConvs.map((c) => c.conversationId);

  if (convIds.length > 0) {
    // HUMAN messages only. Counting agent posts (including the agent's own and
    // other agents' ambient chatter) woke every agent's heartbeat after every
    // agent post — an echo loop. Agent→agent asks arrive as `mention` triggers.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(members, eq(members.id, messages.memberId))
      .where(
        and(
          inArray(messages.conversationId, convIds),
          gt(messages.ts, sinceTs),
          eq(members.kind, "user"),
        ),
      );
    if (n > 0) return "human_message";
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

    // Any new HUMAN comment on these tasks since last run? Wake. Agent
    // comments don't count — counting teammate-agent chatter as "activity"
    // re-created the comment→wake→comment echo loop that wake-damped
    // task_comment triggers were supposed to kill (agents that want a
    // teammate's attention @-mention them, which fires a direct trigger).
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(taskComments)
      .innerJoin(members, eq(members.id, taskComments.memberId))
      .where(
        and(
          inArray(taskComments.taskId, myTaskIds),
          gt(taskComments.ts, sinceTs),
          eq(members.kind, "user"),
        ),
      );
    if (n > 0) return "human_comment";

    // New assignments to this agent (since last run) are activity worth waking for.
    const [{ n: na }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(taskAssignees)
      .where(and(eq(taskAssignees.memberId, agentMember.id), gt(taskAssignees.assignedAt, sinceTs)));
    if (na > 0) return "new_assignment";

    // Any task I own where MY OWN last comment is older than STALE_TASK_MS
    // (or I've never commented)? Wake — time to ship progress. Exempt:
    //   • blocked — needs a human, not an hourly "still blocked" beat (the
    //     deploy-credential spiral was exactly this loop);
    //   • review  — the work is submitted and waiting on a REVIEWER; an
    //     assignee beat here only produces "Proof package v23…v32" re-posts.
    const cutoff = new Date(Date.now() - STALE_TASK_MS);
    for (const t of myOpenTasks) {
      if (t.status === "blocked" || t.status === "review") continue;
      const [latestMine] = await db
        .select({ ts: taskComments.ts })
        .from(taskComments)
        .where(and(eq(taskComments.taskId, t.taskId), eq(taskComments.memberId, agentMember.id)))
        .orderBy(desc(taskComments.ts))
        .limit(1);
      const lastTouch = latestMine?.ts ?? t.updatedAt;
      if (lastTouch < cutoff) return "stale_task";
    }
    return null;
  }

  // New assignments to this agent (since last run) are activity worth waking for.
  const [{ n: na }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(taskAssignees)
    .where(and(eq(taskAssignees.memberId, agentMember.id), gt(taskAssignees.assignedAt, sinceTs)));
  if (na > 0) return "new_assignment";

  return null;
}

worker.on("error", (e) => console.error("[worker] error", e));
worker.on("failed", (job, err) => console.error("[worker] job failed", job?.id, err?.message));

console.log(`[worker] circlechat agent-runs worker up, concurrency=10`);

// Automatic goal planning: a worker that decomposes goals off the HTTP path,
// plus a repeatable sweeper that reconciles unplanned/stuck goals.
startGoalPlanWorker();
scheduleGoalSweep().catch((e) => console.error("[goal-planner] sweep schedule failed", e));
// Daily mission → goals pass: proposes the next goals from the workspace
// mission and files them under projects (see lib/mission-planner.ts).
scheduleMissionSweep().catch((e) => console.error("[mission-planner] schedule failed", e));

// Workflow wakes share the worker process but use a separate queue/concurrency
// pool, so a large timer or poll workload cannot starve ordinary chat turns.
const workflowWorker = startWorkflowWorker();
workflowWorker.on("error", (e) => console.error("[workflow-worker] error", e));
workflowWorker.on("failed", (job, err) =>
  console.error("[workflow-worker] job failed", job?.id, err?.message),
);
console.log(`[worker] circlechat workflow-runs worker up, concurrency=10`);
