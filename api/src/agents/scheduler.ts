import { agentQueue } from "./queue.js";
import { id } from "../lib/ids.js";
import { db } from "../db/index.js";
import { agentRuns } from "../db/schema.js";
import { publishGlobal } from "../lib/events.js";
import { redis } from "../lib/redis.js";
import { heartbeatBackoffMs, noopStreakBackoffMs } from "../lib/run-outcome.js";
import { envInt, envNum } from "../lib/env.js";

const REPEAT_KEY = (agentId: string): string => `hb:${agentId}`;

// ── Non-productive heartbeat backoff ──────────────────────────────────────
// The repeatable BullMQ job keeps firing at the agent's configured interval;
// we can't cheaply retune it per outcome. Instead the worker consults a redis
// "suppress until" stamp before doing the expensive part of a scheduled run.
// Every non-productive heartbeat (idle, failed, all actions rejected, runaway)
// bumps a streak counter and pushes the stamp out exponentially (2×, 4×, 8× the
// base interval …) up to CC_HEARTBEAT_BACKOFF_CAP_MS (default 6h). Any
// productive run — or any event trigger (mention, DM, task_comment…), which
// never consults the stamp — resets it.
const STREAK_KEY = (agentId: string): string => `cc:hb:streak:${agentId}`;
const UNTIL_KEY = (agentId: string): string => `cc:hb:until:${agentId}`;
const STREAK_TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_CAP_MS = envNum("CC_HEARTBEAT_BACKOFF_CAP_MS", 6 * 60 * 60 * 1000, { min: 1 });

export async function noteHeartbeatOutcome(
  agentId: string,
  productive: boolean,
  intervalSec: number,
): Promise<{ streak: number; backoffMs: number }> {
  try {
    if (productive) {
      await redis.del(STREAK_KEY(agentId), UNTIL_KEY(agentId));
      return { streak: 0, backoffMs: 0 };
    }
    const streak = await redis.incr(STREAK_KEY(agentId));
    await redis.pexpire(STREAK_KEY(agentId), STREAK_TTL_MS);
    const backoffMs = heartbeatBackoffMs(streak, Math.max(5_000, intervalSec * 1000), BACKOFF_CAP_MS);
    if (backoffMs > 0) {
      await redis.set(UNTIL_KEY(agentId), String(Date.now() + backoffMs), "PX", backoffMs);
    }
    return { streak, backoffMs };
  } catch {
    return { streak: 0, backoffMs: 0 };
  }
}

// Milliseconds the agent's scheduled heartbeat is still suppressed for (0 = run).
export async function heartbeatBackoffRemainingMs(agentId: string): Promise<number> {
  try {
    const v = await redis.get(UNTIL_KEY(agentId));
    if (!v) return 0;
    return Math.max(0, Number(v) - Date.now());
  } catch {
    return 0;
  }
}

export async function clearHeartbeatBackoff(agentId: string): Promise<void> {
  try {
    await redis.del(STREAK_KEY(agentId), UNTIL_KEY(agentId), SKIP_STREAK_KEY(agentId), SKIP_UNTIL_KEY(agentId));
  } catch {
    /* ignore */
  }
}

// ── Scheduled-tick (no-op) backoff ────────────────────────────────────────
// One level earlier than the heartbeat backoff above: this one suppresses the
// tick BEFORE a run row is materialised, so a repeatedly-empty schedule stops
// producing agent_runs at all. Counted when the activity gate finds nothing to
// do ({"skipped":"no_activity"}), cleared the moment a real reason to wake
// appears (a human message/comment/assignment) or a run applies anything.
const SKIP_STREAK_KEY = (agentId: string): string => `cc:sched:skip:${agentId}`;
const SKIP_UNTIL_KEY = (agentId: string): string => `cc:sched:until:${agentId}`;
const SKIP_MIN_STREAK = envInt("CC_SCHEDULED_SKIP_STREAK", 3, { min: 1 });
const SKIP_CAP_MS = envNum("CC_SCHEDULED_BACKOFF_CAP_MS", 6 * 60 * 60 * 1000, { min: 1 });

export async function noteScheduledSkip(
  agentId: string,
  intervalSec: number,
): Promise<{ streak: number; backoffMs: number }> {
  try {
    const streak = await redis.incr(SKIP_STREAK_KEY(agentId));
    await redis.pexpire(SKIP_STREAK_KEY(agentId), STREAK_TTL_MS);
    const backoffMs = noopStreakBackoffMs(
      streak,
      Math.max(5_000, intervalSec * 1000),
      SKIP_CAP_MS,
      SKIP_MIN_STREAK,
    );
    if (backoffMs > 0) {
      await redis.set(SKIP_UNTIL_KEY(agentId), String(Date.now() + backoffMs), "PX", backoffMs);
    }
    return { streak, backoffMs };
  } catch {
    return { streak: 0, backoffMs: 0 };
  }
}

/** Milliseconds this agent's scheduled TICK is still suppressed for (0 = run it). */
export async function scheduledSkipRemainingMs(agentId: string): Promise<number> {
  try {
    const v = await redis.get(SKIP_UNTIL_KEY(agentId));
    if (!v) return 0;
    return Math.max(0, Number(v) - Date.now());
  } catch {
    return 0;
  }
}

/** Real activity — decay the no-op streak all the way back, not one step. */
export async function clearScheduledSkipBackoff(agentId: string): Promise<void> {
  try {
    await redis.del(SKIP_STREAK_KEY(agentId), SKIP_UNTIL_KEY(agentId));
  } catch {
    /* ignore */
  }
}

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
  const key = REPEAT_KEY(agentId);
  const repeats = await agentQueue.getRepeatableJobs();
  for (const r of repeats) {
    // The repeatable job is identified by its NAME (set via agentQueue.add(key,…));
    // getRepeatableJobs() returns id=undefined, so matching on r.id silently
    // matched nothing and old schedules piled up (duplicate heartbeats). Match
    // on name (keep id as a fallback).
    if (r.name === key || r.id === key) {
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
