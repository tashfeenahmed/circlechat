import { Worker } from "bullmq";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agentConnectorGrants,
  agents,
  connectors,
  workflowRuns,
  workflows,
  workflowSteps,
  type WorkflowDefinition,
  type WorkflowStateDefinition,
} from "../db/schema.js";
import { enqueueAgentEvent } from "../agents/enqueue.js";
import { id } from "./ids.js";
import { redis } from "./redis.js";
import { publishToWorkspace } from "./events.js";
import { invokeConnector } from "./connector-runtime.js";
import { parseWorkflowDefinition, readPath, stateById, transitionFor } from "./workflow-definition.js";
import { enqueueWorkflowRun, WORKFLOW_QUEUE, type WorkflowJobPayload } from "./workflow-queue.js";

type WorkflowRun = typeof workflowRuns.$inferSelect;
type WorkflowStep = typeof workflowSteps.$inferSelect;

export async function startWorkflowRun(input: {
  workflowId: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  createdBy: string;
}): Promise<string> {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, input.workspaceId)))
    .limit(1);
  if (!workflow) throw new Error("workflow_not_found");
  if (workflow.status !== "active") throw new Error("workflow_paused");
  const definition = parseWorkflowDefinition(workflow.definitionJson);
  const runId = id("wfrun");
  await db.insert(workflowRuns).values({
    id: runId,
    workflowId: workflow.id,
    workspaceId: workflow.workspaceId,
    status: "queued",
    currentStateId: definition.start,
    inputJson: input.payload,
    outputJson: {},
    createdBy: input.createdBy,
    ownerMemberId: input.createdBy,
  });
  await enqueueWorkflowRun(runId, "start");
  await publishToWorkspace(input.workspaceId, {
    type: "workflow.run.updated",
    workspaceId: input.workspaceId,
    workflowId: workflow.id,
    runId,
    status: "queued",
  });
  return runId;
}

async function loadRun(runId: string): Promise<{
  run: WorkflowRun;
  workflow: typeof workflows.$inferSelect;
  definition: WorkflowDefinition;
}> {
  const [row] = await db
    .select({ run: workflowRuns, workflow: workflows })
    .from(workflowRuns)
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  if (!row) throw new Error("workflow_run_not_found");
  return { ...row, definition: parseWorkflowDefinition(row.workflow.definitionJson) };
}

async function nextAttempt(runId: string, stateId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`coalesce(max(${workflowSteps.attempt}), 0)::int` })
    .from(workflowSteps)
    .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.stateId, stateId)));
  return (row?.value ?? 0) + 1;
}

async function createStep(run: WorkflowRun, state: WorkflowStateDefinition): Promise<WorkflowStep> {
  const step: typeof workflowSteps.$inferInsert = {
    id: id("wfstep"),
    runId: run.id,
    stateId: state.id,
    kind: state.type,
    attempt: await nextAttempt(run.id, state.id),
    status: "running",
    inputJson: run.inputJson,
    outputJson: {},
  };
  await db.insert(workflowSteps).values(step);
  return step as WorkflowStep;
}

async function setStepOutput(
  stepId: string,
  status: "completed" | "failed" | "waiting",
  output: Record<string, unknown> = {},
  errorText: string | null = null,
): Promise<void> {
  await db
    .update(workflowSteps)
    .set({
      status,
      outputJson: output,
      errorText,
      ...(status === "waiting" ? {} : { finishedAt: new Date() }),
    })
    .where(eq(workflowSteps.id, stepId));
}

function mergedOutputs(run: WorkflowRun, stateId: string, output: unknown): Record<string, unknown> {
  return { ...(run.outputJson ?? {}), [stateId]: output };
}

async function advance(
  run: WorkflowRun,
  state: WorkflowStateDefinition,
  outcome: "success" | "failure",
  output: unknown,
  errorText?: string,
): Promise<void> {
  const next = transitionFor(state, outcome);
  const outputs = mergedOutputs(run, state.id, output);
  if (!next) {
    const status = outcome === "success" ? "completed" : "failed";
    await db
      .update(workflowRuns)
      .set({
        status,
        outputJson: outputs,
        errorText: errorText ?? null,
        waitKind: null,
        waitKey: null,
        waitUntil: null,
        updatedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(workflowRuns.id, run.id));
    await publishRun(run, status);
    return;
  }
  await db
    .update(workflowRuns)
    .set({
      status: "queued",
      currentStateId: next,
      outputJson: outputs,
      errorText: null,
      waitKind: null,
      waitKey: null,
      waitUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(workflowRuns.id, run.id));
  await enqueueWorkflowRun(run.id, "transition");
  await publishRun(run, "queued");
}

async function publishRun(run: WorkflowRun, status: string): Promise<void> {
  await publishToWorkspace(run.workspaceId, {
    type: "workflow.run.updated",
    workspaceId: run.workspaceId,
    workflowId: run.workflowId,
    runId: run.id,
    status,
  });
}

async function executeConnectorState(
  run: WorkflowRun,
  state: WorkflowStateDefinition,
): Promise<unknown> {
  const cfg = state.config ?? {};
  const connectorId = String(cfg.connectorId);
  const [connector] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, run.workspaceId)))
    .limit(1);
  if (!connector) throw new Error("connector_not_found");
  if (typeof cfg.agentId === "string") {
    const [grant] = await db
      .select()
      .from(agentConnectorGrants)
      .where(
        and(
          eq(agentConnectorGrants.connectorId, connector.id),
          eq(agentConnectorGrants.agentId, cfg.agentId),
        ),
      )
      .limit(1);
    if (!grant) throw new Error("connector_not_granted_to_agent");
  }
  return invokeConnector(connector, {
    operation: typeof cfg.operation === "string" ? cfg.operation : undefined,
    method: typeof cfg.method === "string" ? cfg.method : undefined,
    path: typeof cfg.path === "string" ? cfg.path : undefined,
    headers: (cfg.headers ?? {}) as Record<string, string>,
    query: (cfg.query ?? {}) as Record<string, string | number | boolean>,
    body: cfg.body,
    input: run.inputJson,
    steps: run.outputJson,
  });
}

async function resumeTimer(run: WorkflowRun, definition: WorkflowDefinition, stepId: string): Promise<void> {
  if (run.status !== "waiting" || run.waitKind !== "timer" || run.waitKey !== stepId) return;
  const [step] = await db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)).limit(1);
  if (!step || step.runId !== run.id || step.status !== "waiting") return;
  const state = stateById(definition, step.stateId);
  const output = { waitedUntil: new Date().toISOString() };
  await setStepOutput(step.id, "completed", output);
  await advance(run, state, "success", output);
}

export async function processWorkflowJob(payload: WorkflowJobPayload): Promise<void> {
  const { run, definition } = await loadRun(payload.runId);
  if (["completed", "failed", "cancelled"].includes(run.status)) return;
  if (run.cancelRequestedAt || (run.timeoutAt && run.timeoutAt <= new Date())) {
    await db.update(workflowRuns).set({
      status: "cancelled", errorText: run.cancelRequestedAt ? "cancelled_by_user" : "run_timeout",
      finishedAt: new Date(), updatedAt: new Date(),
    }).where(eq(workflowRuns.id, run.id));
    await publishRun(run, "cancelled");
    return;
  }
  if (payload.reason === "timer" && payload.resumeStepId) {
    await resumeTimer(run, definition, payload.resumeStepId);
    return;
  }
  // Only poll wakes are allowed to re-enter an explicitly waiting run. Agent
  // and human resumes advance the row to queued before enqueuing.
  if (run.status === "waiting" && !(payload.reason === "poll" && run.waitKind === "poll")) return;
  const stateId = run.currentStateId ?? definition.start;
  const state = stateById(definition, stateId);
  await db
    .update(workflowRuns)
    .set({ status: "running", waitKind: null, waitKey: null, waitUntil: null, updatedAt: new Date() })
    .where(eq(workflowRuns.id, run.id));
  const activeRun = { ...run, status: "running", currentStateId: stateId };
  const step = await createStep(activeRun, state);

  try {
    if (state.type === "agent") {
      const agentId = String(state.config?.agentId);
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, run.workspaceId)))
        .limit(1);
      if (!agent) throw new Error("workflow_agent_not_found");
      const agentRunId = await enqueueAgentEvent(agentId, {
        trigger: "workflow",
        workflowRunId: run.id,
        workflowStepId: step.id,
      });
      await db
        .update(workflowSteps)
        .set({ status: "waiting", agentRunId })
        .where(eq(workflowSteps.id, step.id));
      await db
        .update(workflowRuns)
        .set({ status: "waiting", waitKind: "agent", waitKey: step.id, updatedAt: new Date() })
        .where(eq(workflowRuns.id, run.id));
      await publishRun(run, "waiting");
      return;
    }

    if (state.type === "connector") {
      const result = await executeConnectorState(activeRun, state);
      await setStepOutput(step.id, "completed", result as Record<string, unknown>);
      await advance(activeRun, state, "success", result);
      return;
    }

    if (state.type === "wait") {
      const durationSeconds = Number(state.config?.durationSeconds);
      const waitUntil = new Date(Date.now() + durationSeconds * 1000);
      await setStepOutput(step.id, "waiting", { waitUntil: waitUntil.toISOString() });
      await db
        .update(workflowRuns)
        .set({ status: "waiting", waitKind: "timer", waitKey: step.id, waitUntil, updatedAt: new Date() })
        .where(eq(workflowRuns.id, run.id));
      await enqueueWorkflowRun(run.id, "timer", { delayMs: durationSeconds * 1000, resumeStepId: step.id });
      await publishRun(run, "waiting");
      return;
    }

    if (state.type === "approval") {
      await setStepOutput(step.id, "waiting", { prompt: String(state.config?.prompt ?? state.name ?? state.id) });
      await db
        .update(workflowRuns)
        .set({ status: "waiting", waitKind: "human", waitKey: step.id, updatedAt: new Date() })
        .where(eq(workflowRuns.id, run.id));
      await publishRun(run, "waiting");
      return;
    }

    if (state.type === "poll") {
      const result = await executeConnectorState(activeRun, state);
      const value = readPath(result, String(state.config?.path ?? "data"));
      const matches = state.config && "equals" in state.config
        ? JSON.stringify(value) === JSON.stringify(state.config.equals)
        : Boolean(value);
      if (matches) {
        await setStepOutput(step.id, "completed", result as Record<string, unknown>);
        await advance(activeRun, state, "success", result);
        return;
      }
      const intervalSeconds = Number(state.config?.intervalSeconds ?? 30);
      const timeoutSeconds = Number(state.config?.timeoutSeconds ?? 3600);
      if (step.attempt * intervalSeconds >= timeoutSeconds) {
        const error = "poll_timeout";
        await setStepOutput(step.id, "failed", result as Record<string, unknown>, error);
        await advance(activeRun, state, "failure", result, error);
        return;
      }
      const waitUntil = new Date(Date.now() + intervalSeconds * 1000);
      await setStepOutput(step.id, "waiting", result as Record<string, unknown>);
      await db
        .update(workflowRuns)
        .set({ status: "waiting", waitKind: "poll", waitKey: step.id, waitUntil, updatedAt: new Date() })
        .where(eq(workflowRuns.id, run.id));
      await enqueueWorkflowRun(run.id, "poll", { delayMs: intervalSeconds * 1000 });
      await publishRun(run, "waiting");
      return;
    }

    const terminalStatus = String(state.config?.status ?? "completed");
    const output = (state.config?.output ?? activeRun.outputJson) as Record<string, unknown>;
    await setStepOutput(step.id, terminalStatus === "failed" ? "failed" : "completed", output);
    await db
      .update(workflowRuns)
      .set({
        status: terminalStatus === "failed" ? "failed" : "completed",
        outputJson: mergedOutputs(activeRun, state.id, output),
        errorText: terminalStatus === "failed" ? String(state.config?.error ?? "workflow_failed") : null,
        updatedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(workflowRuns.id, run.id));
    await publishRun(run, terminalStatus === "failed" ? "failed" : "completed");
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    await setStepOutput(step.id, "failed", {}, message);
    await advance(activeRun, state, "failure", {}, message);
  }
}

export async function resumeWorkflowFromAgent(input: {
  workflowRunId: string;
  workflowStepId: string;
  success: boolean;
  output: Record<string, unknown>;
  errorText?: string;
}): Promise<void> {
  const { run, definition } = await loadRun(input.workflowRunId);
  if (run.status !== "waiting" || run.waitKind !== "agent" || run.waitKey !== input.workflowStepId) return;
  const [step] = await db.select().from(workflowSteps).where(eq(workflowSteps.id, input.workflowStepId)).limit(1);
  if (!step || step.runId !== run.id || step.status !== "waiting") return;
  const state = stateById(definition, step.stateId);
  await setStepOutput(step.id, input.success ? "completed" : "failed", input.output, input.errorText ?? null);
  await advance(run, state, input.success ? "success" : "failure", input.output, input.errorText);
}

export async function resumeWorkflowFromHuman(input: {
  runId: string;
  workspaceId: string;
  approved: boolean;
  output: Record<string, unknown>;
}): Promise<void> {
  const { run, definition } = await loadRun(input.runId);
  if (run.workspaceId !== input.workspaceId) throw new Error("workflow_run_not_found");
  if (run.status !== "waiting" || run.waitKind !== "human" || !run.waitKey) {
    throw new Error("workflow_not_waiting_for_human");
  }
  const [step] = await db.select().from(workflowSteps).where(eq(workflowSteps.id, run.waitKey)).limit(1);
  if (!step || step.runId !== run.id || step.status !== "waiting") throw new Error("workflow_wait_step_missing");
  const state = stateById(definition, step.stateId);
  await setStepOutput(step.id, input.approved ? "completed" : "failed", input.output, input.approved ? null : "denied");
  await advance(run, state, input.approved ? "success" : "failure", input.output, input.approved ? undefined : "denied");
}

export async function workflowAgentContext(runId: string): Promise<{
  runId: string;
  workflowId: string;
  name: string;
  stateId: string | null;
  input: Record<string, unknown>;
  priorStepOutputs: Record<string, unknown>;
  steer: Array<Record<string, unknown>>;
  followUps: Array<Record<string, unknown>>;
} | null> {
  const [row] = await db
    .select({ run: workflowRuns, name: workflows.name })
    .from(workflowRuns)
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  if (!row) return null;
  return {
    runId: row.run.id,
    workflowId: row.run.workflowId,
    name: row.name,
    stateId: row.run.currentStateId,
    input: row.run.inputJson,
    priorStepOutputs: row.run.outputJson,
    steer: row.run.steerJson,
    followUps: row.run.followupJson,
  };
}

export function startWorkflowWorker(): Worker<WorkflowJobPayload> {
  return new Worker<WorkflowJobPayload>(WORKFLOW_QUEUE, (job) => processWorkflowJob(job.data), {
    connection: redis,
    concurrency: 10,
    lockDuration: 120_000,
  });
}
