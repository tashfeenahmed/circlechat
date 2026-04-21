import { agentQueue } from "./queue.js";
import { id } from "../lib/ids.js";
import { db } from "../db/index.js";
import { agentRuns } from "../db/schema.js";
import { publishGlobal } from "../lib/events.js";

const REPEAT_KEY = (agentId: string): string => `hb:${agentId}`;

// Repeating jobs that enqueue a scheduled agent-run.
export async function scheduleAgentHeartbeat(agentId: string, everySec: number): Promise<void> {
  await cancelAgentHeartbeat(agentId);
  const ms = Math.max(5_000, everySec * 1000);
  await agentQueue.add(
    REPEAT_KEY(agentId),
    { agentId, runId: "", trigger: "scheduled" as const },
    {
      repeat: { every: ms },
      jobId: REPEAT_KEY(agentId),
    },
  );
}

export async function cancelAgentHeartbeat(agentId: string): Promise<void> {
  const repeats = await agentQueue.getRepeatableJobs();
  for (const r of repeats) {
    if (r.id === REPEAT_KEY(agentId)) {
      await agentQueue.removeRepeatableByKey(r.key);
    }
  }
}

// Called by the worker when a scheduled tick fires — materialises an agent_run row
// then hands off to the executor.
export async function materialiseScheduledRun(agentId: string): Promise<string> {
  const runId = id("run");
  await db.insert(agentRuns).values({
    id: runId,
    agentId,
    trigger: "scheduled",
    status: "queued",
    contextJson: {},
    resultJson: {},
    traceJson: [],
  });
  await publishGlobal({
    type: "agent.run.started",
    conversationId: null,
    agentId,
    runId,
    trigger: "scheduled",
  });
  return runId;
}
