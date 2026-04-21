import { eq } from "drizzle-orm";
import { agentQueue, type AgentJobPayload } from "./queue.js";
import { db } from "../db/index.js";
import { agentRuns, agents } from "../db/schema.js";
import { id } from "../lib/ids.js";
import { publishToConversation, publishGlobal } from "../lib/events.js";

type Trigger = AgentJobPayload["trigger"];

export async function enqueueAgentEvent(
  agentId: string,
  ev: { trigger: Trigger; conversationId?: string | null; messageId?: string; approvalId?: string; status?: string },
): Promise<string> {
  const runId = id("run");
  await db.insert(agentRuns).values({
    id: runId,
    agentId,
    trigger: ev.trigger,
    status: "queued",
    conversationId: ev.conversationId ?? null,
    contextJson: {},
    resultJson: {},
    traceJson: [],
  });

  // Stash the agent's display name/handle on the WS frame so clients can
  // render a helpful "Ben is drafting…" pill without needing the members
  // directory already loaded.
  const [a] = await db
    .select({ name: agents.name, handle: agents.handle })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const ev2 = {
    type: "agent.run.started" as const,
    conversationId: ev.conversationId ?? null,
    agentId,
    agentName: a?.name ?? null,
    agentHandle: a?.handle ?? null,
    runId,
    trigger: ev.trigger,
  };
  if (ev.conversationId) await publishToConversation(ev.conversationId, ev2);
  else await publishGlobal(ev2);

  await agentQueue.add(
    `run:${runId}`,
    {
      agentId,
      runId,
      trigger: ev.trigger,
      conversationId: ev.conversationId ?? null,
      messageId: ev.messageId,
      approvalId: ev.approvalId,
      status: ev.status,
    } satisfies AgentJobPayload,
    { jobId: runId },
  );
  return runId;
}
