import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, agentRuns } from "../db/schema.js";
import { redis } from "./redis.js";
import { notifyAdmins } from "./budgets.js";

// Productivity review (Paperclip-style): an agent that keeps making real LLM
// runs while applying zero actions is spinning — every reply is getting
// rejected by the guard, coming back empty, or failing. Each run still costs
// money, so surface it to a human instead of letting it burn quietly. The
// goal-sweep calls this every tick; redis dedupes to one alert per agent per
// review window.

const WINDOW_MS = 24 * 60 * 60 * 1000;

const minRuns = (): number => {
  const v = Number(process.env.CC_PRODUCTIVITY_MIN_RUNS_24H ?? "12");
  return Number.isFinite(v) && v >= 1 ? v : 12;
};

// Pure: flag when the agent did a meaningful amount of real work-attempts and
// NONE of it landed. `runs` must exclude skipped (no-LLM-call) heartbeats.
export function needsProductivityReview(
  stats: { runs: number; applied: number },
  threshold: number = minRuns(),
): boolean {
  return stats.runs >= threshold && stats.applied === 0;
}

export async function runProductivityReview(): Promise<void> {
  const since = new Date(Date.now() - WINDOW_MS);

  // Real runs only: skipped heartbeats (idle gate, budget gate) never called
  // the LLM and shouldn't count as "activity without output".
  const rows = await db
    .select({
      agentId: agentRuns.agentId,
      runs: sql<number>`count(*)::int`,
      applied: sql<number>`coalesce(sum((${agentRuns.resultJson}->>'applied')::int), 0)::int`,
      failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
      costUsd: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
    })
    .from(agentRuns)
    .where(and(gte(agentRuns.startedAt, since), isNull(sql`${agentRuns.resultJson}->>'skipped'`)))
    .groupBy(agentRuns.agentId);

  for (const r of rows) {
    if (!needsProductivityReview({ runs: r.runs, applied: r.applied })) continue;

    const [agent] = await db
      .select({
        id: agents.id,
        workspaceId: agents.workspaceId,
        name: agents.name,
        handle: agents.handle,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, r.agentId))
      .limit(1);
    if (!agent || agent.status === "paused") continue;

    // One alert per agent per window — survives worker restarts, unlike an
    // in-memory marker, and needs no schema change.
    const dedupeKey = `cc:productivity-review:${agent.id}`;
    const first = await redis.set(dedupeKey, "1", "PX", WINDOW_MS, "NX");
    if (first !== "OK") continue;

    await notifyAdmins(agent.workspaceId, {
      title: `@${agent.handle} ran ${r.runs} times today with nothing to show`,
      body:
        `${agent.name} made ${r.runs} LLM runs in the last 24h (est. $${r.costUsd.toFixed(2)}) ` +
        `but applied 0 actions${r.failed ? ` (${r.failed} failed outright)` : ""}. ` +
        `Check its recent runs — it may be stuck on a rejected reply pattern, a dead task, ` +
        `or a model that can't handle its workload. Pausing it stops the spend.`,
      link: `/agents/${agent.id}`,
    });
    console.log(
      `[productivity] flagged @${agent.handle}: runs=${r.runs} applied=0 failed=${r.failed} est=$${r.costUsd.toFixed(2)}`,
    );
  }
}
