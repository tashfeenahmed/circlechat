import { Queue, QueueEvents } from "bullmq";
import { redis } from "../lib/redis.js";

export const AGENT_QUEUE = "agent-runs";

export const agentQueue = new Queue(AGENT_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1500 },
    removeOnComplete: 500,
    removeOnFail: 500,
  },
});

export const agentQueueEvents = new QueueEvents(AGENT_QUEUE, { connection: redis });

export interface AgentJobPayload {
  agentId: string;
  runId: string;
  trigger:
    | "scheduled"
    | "mention"
    | "dm"
    | "thread_reply"
    | "channel_post"
    | "assigned"
    | "task_assigned"
    | "task_comment"
    | "approval_response"
    | "test"
    | "ambient"
    // Immediate follow-up turn the worker grants itself after a run that made
    // board progress, so multi-step work doesn't stall until the next
    // heartbeat. Bounded by chainDepth + the per-run budget gate.
    | "continuation";
  conversationId?: string | null;
  messageId?: string;
  approvalId?: string;
  taskId?: string;
  status?: string;
  // How many continuations deep this run is (0 = a normal trigger). Capped in
  // the worker so a chain can't run away.
  chainDepth?: number;
}
