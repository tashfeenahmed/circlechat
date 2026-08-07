import { Queue } from "bullmq";
import { redis } from "./redis.js";
import { id } from "./ids.js";

export const WORKFLOW_QUEUE = "workflow-runs";

export interface WorkflowJobPayload {
  runId: string;
  reason: "start" | "transition" | "timer" | "poll" | "agent" | "human" | "retry";
  resumeStepId?: string;
}

export const workflowQueue = new Queue<WorkflowJobPayload>(WORKFLOW_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
  },
});

export async function enqueueWorkflowRun(
  runId: string,
  reason: WorkflowJobPayload["reason"],
  opts: { delayMs?: number; resumeStepId?: string } = {},
): Promise<void> {
  await workflowQueue.add(
    `workflow:${runId}`,
    { runId, reason, resumeStepId: opts.resumeStepId },
    { jobId: id("wfjob"), delay: Math.max(0, opts.delayMs ?? 0) },
  );
}
