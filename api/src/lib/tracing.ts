import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, agents } from "../db/schema.js";

// Optional standard observability export. Every agent run already records a
// full audit row (trigger, context, result, trace steps, cost, error) in
// `agent_runs`; this ships that row to Langfuse's ingestion API as a trace + a
// generation observation so runs show up in a standard LLM-tracing UI.
//
// It is dependency-free (just `fetch`) and FULLY no-op unless all three env
// vars are set, so the code is safe to ship dark and turned on per-deployment:
//   LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
// (Langfuse Cloud or a self-hosted instance — the ingestion endpoint is the
// same OTel-adjacent contract AgentOps/others also accept via Langfuse.)
const host = (): string => (process.env.LANGFUSE_HOST || "").replace(/\/+$/, "");
const publicKey = (): string => process.env.LANGFUSE_PUBLIC_KEY || "";
const secretKey = (): string => process.env.LANGFUSE_SECRET_KEY || "";

export function tracingEnabled(): boolean {
  return !!(host() && publicKey() && secretKey());
}

// Ship one finished run to Langfuse. Best-effort and self-contained: callers
// fire-and-forget, and any failure (bad config, network) is swallowed so
// tracing can never break or slow an agent run.
export async function exportRunTrace(agentId: string, runId: string): Promise<void> {
  if (!tracingEnabled() || !runId) return;
  try {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (!run) return;
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);

    const startIso = (run.startedAt ?? new Date()).toISOString();
    const endIso = (run.finishedAt ?? new Date()).toISOString();
    const level = run.status === "failed" ? "ERROR" : "DEFAULT";
    const name = `agent-run:${run.trigger}`;

    const batch = [
      {
        id: `${runId}-t`,
        type: "trace-create",
        timestamp: startIso,
        body: {
          id: runId,
          name,
          timestamp: startIso,
          userId: agent?.handle ?? agentId,
          metadata: {
            agentId,
            agentHandle: agent?.handle ?? null,
            trigger: run.trigger,
            status: run.status,
            conversationId: run.conversationId,
          },
          input: run.contextJson ?? undefined,
          output: run.resultJson ?? undefined,
        },
      },
      {
        id: `${runId}-g`,
        type: "observation-create",
        timestamp: startIso,
        body: {
          id: `${runId}-g`,
          traceId: runId,
          type: "GENERATION",
          name,
          startTime: startIso,
          endTime: endIso,
          model: agent?.model || "auto",
          level,
          statusMessage: run.errorText ?? undefined,
          input: run.contextJson ?? undefined,
          output: { trace: run.traceJson ?? [], result: run.resultJson ?? null },
          metadata: { costUsd: run.costUsd ?? null },
        },
      },
    ];

    const auth = Buffer.from(`${publicKey()}:${secretKey()}`).toString("base64");
    await fetch(`${host()}/api/public/ingestion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({ batch }),
    });
  } catch {
    /* tracing is best-effort — never let it surface to the run */
  }
}
