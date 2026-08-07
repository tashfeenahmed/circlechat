import { z } from "zod";
import type { WorkflowDefinition, WorkflowStateDefinition } from "../db/schema.js";

const StateId = z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
const State = z.object({
  id: StateId,
  type: z.enum(["agent", "connector", "wait", "approval", "poll", "terminal"]),
  name: z.string().max(120).optional(),
  next: StateId.optional(),
  onSuccess: StateId.optional(),
  onFailure: StateId.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
const Definition = z.object({ start: StateId, states: z.array(State).min(1).max(100) });

export function parseWorkflowDefinition(input: unknown): WorkflowDefinition {
  const parsed = Definition.parse(input) as WorkflowDefinition;
  const ids = new Set<string>();
  for (const state of parsed.states) {
    if (ids.has(state.id)) throw new Error(`duplicate_state:${state.id}`);
    ids.add(state.id);
  }
  if (!ids.has(parsed.start)) throw new Error(`start_state_missing:${parsed.start}`);
  for (const state of parsed.states) {
    for (const target of [state.next, state.onSuccess, state.onFailure]) {
      if (target && !ids.has(target)) throw new Error(`transition_target_missing:${state.id}:${target}`);
    }
    validateStateConfig(state);
  }
  return parsed;
}

function validateStateConfig(state: WorkflowStateDefinition): void {
  const cfg = state.config ?? {};
  if (state.type === "agent" && typeof cfg.agentId !== "string") {
    throw new Error(`agent_state_requires_agent_id:${state.id}`);
  }
  if ((state.type === "connector" || state.type === "poll") && typeof cfg.connectorId !== "string") {
    throw new Error(`connector_state_requires_connector_id:${state.id}`);
  }
  if (state.type === "wait") {
    const seconds = Number(cfg.durationSeconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30 * 24 * 60 * 60) {
      throw new Error(`wait_duration_invalid:${state.id}`);
    }
  }
  if (state.type === "poll") {
    const seconds = Number(cfg.intervalSeconds ?? 30);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 24 * 60 * 60) {
      throw new Error(`poll_interval_invalid:${state.id}`);
    }
  }
  if (state.type === "terminal") {
    const status = String(cfg.status ?? "completed");
    if (status !== "completed" && status !== "failed") {
      throw new Error(`terminal_status_invalid:${state.id}`);
    }
  }
}

export function stateById(definition: WorkflowDefinition, stateId: string): WorkflowStateDefinition {
  const state = definition.states.find((candidate) => candidate.id === stateId);
  if (!state) throw new Error(`workflow_state_missing:${stateId}`);
  return state;
}

export function transitionFor(
  state: WorkflowStateDefinition,
  outcome: "success" | "failure",
): string | null {
  return (outcome === "success" ? state.onSuccess : state.onFailure) ?? state.next ?? null;
}

// JSON-safe template resolver used by connector states. Exact `$input.foo`
// expressions retain the source value's type; embedded expressions stringify.
// `$steps.<state>...` addresses outputs accumulated by earlier states.
export function resolveWorkflowTemplate(
  value: unknown,
  context: { input: Record<string, unknown>; steps: Record<string, unknown> },
): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveWorkflowTemplate(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        resolveWorkflowTemplate(child, context),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  const exact = /^\$(input|steps)(?:\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?$/.exec(value);
  if (exact) return readPath(context[exact[1] as "input" | "steps"], exact[2] ?? "");
  return value.replace(/\$(input|steps)\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)/g, (_m, root, path) => {
    const found = readPath(context[root as "input" | "steps"], path);
    return found == null ? "" : typeof found === "string" ? found : JSON.stringify(found);
  });
}

export function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}
