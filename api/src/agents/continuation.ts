import type { AgentAction } from "./executor.js";

// Agent-requested follow-up turns (Letta v3 continuation rule): after a run
// that advanced the board, the worker grants an IMMEDIATE next turn instead of
// waiting for the next heartbeat — so multi-step work (decompose a goal → start
// the first task → comment progress) flows in one sitting. Opt-in
// (CC_AGENT_CONTINUATION=on), bounded by chain depth, and gated by the same
// per-run budget check as any other trigger. Pure logic lives here so it's unit
// testable without booting the worker's BullMQ/Redis side effects.

// Only "progress" actions qualify. Pure chat/reactions and memory edits are
// self-complete turns; request_approval means the agent is now parked.
const CONTINUATION_ACTIONS = new Set([
  "create_task",
  "update_task",
  "assign_task",
  "create_goal",
  "decompose_goal",
  "share_to_task",
]);

export function continuationEnabled(): boolean {
  return process.env.CC_AGENT_CONTINUATION === "on";
}

export function continuationMax(): number {
  const n = Number(process.env.CC_CONTINUATION_MAX ?? "2");
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

export function shouldContinue(
  actions: AgentAction[],
  chainDepth: number,
  max: number = continuationMax(),
): boolean {
  if (chainDepth >= max) return false;
  if (actions.some((a) => a.type === "request_approval")) return false; // parked on a human
  return actions.some((a) => CONTINUATION_ACTIONS.has(a.type));
}
