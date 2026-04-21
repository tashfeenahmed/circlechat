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
    | "ambient";
  conversationId?: string | null;
  messageId?: string;
  approvalId?: string;
  taskId?: string;
  status?: string;
}
