import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, agentRuns } from "../db/schema.js";
import { publishToConversation, publishGlobal } from "./events.js";

// Crash recovery for the run loop. When a worker dies mid-run the run row
// stays 'running' and the agent stays 'working' forever: the UI shows a
// permanent thinking pill, the activity gate misreads the agent as busy, and
// nobody learns the run died. The sweep calls this to fail-out runs stuck
// past the window and put their agents back to idle. The failure is recorded
// as reaped_stuck_run, which the next run's context surfaces to the agent
// (see previousRunFailure) so the work isn't silently forgotten.

// BullMQ's lockDuration is 240s and a stalled job gets one retry, so any run
// legitimately alive is well under this.
const STUCK_RUN_MS = Number(process.env.CC_STUCK_RUN_MS ?? 15 * 60 * 1000);

export async function reapStuckRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_RUN_MS);
  const reaped = await db
    .update(agentRuns)
    .set({ status: "failed", errorText: "reaped_stuck_run", finishedAt: new Date() })
    .where(and(eq(agentRuns.status, "running"), lt(agentRuns.startedAt, cutoff)))
    .returning({
      id: agentRuns.id,
      agentId: agentRuns.agentId,
      conversationId: agentRuns.conversationId,
    });

  for (const r of reaped) {
    // Only idle the agent if nothing else of theirs is still genuinely running.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, r.agentId), eq(agentRuns.status, "running")));
    if (n === 0) {
      await db
        .update(agents)
        .set({ status: "idle" })
        .where(and(eq(agents.id, r.agentId), eq(agents.status, "working")));
    }

    // Clear the stuck "thinking" pill in the UI.
    const frame = {
      type: "agent.run.finished" as const,
      agentId: r.agentId,
      runId: r.id,
      status: "failed",
    };
    if (r.conversationId) {
      await publishToConversation(r.conversationId, { ...frame, conversationId: r.conversationId }).catch(() => {});
    } else {
      await publishGlobal({ ...frame, conversationId: null }).catch(() => {});
    }
  }

  if (reaped.length) console.log(`[run-reaper] failed out ${reaped.length} stuck run(s)`);
  return reaped.length;
}
