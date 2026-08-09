import { describe, expect, it } from "vitest";
import {
  parseWorkflowDefinition,
  resolveWorkflowTemplate,
  transitionFor,
} from "../lib/workflow-definition.js";

describe("workflow definition validation", () => {
  it("accepts all durable state families and resolves branches", () => {
    const definition = parseWorkflowDefinition({
      start: "agent",
      states: [
        { id: "agent", type: "agent", config: { agentId: "a_1" }, onSuccess: "tool", onFailure: "failed" },
        { id: "tool", type: "connector", config: { connectorId: "conn_1" }, next: "wait" },
        { id: "wait", type: "wait", config: { durationSeconds: 2 }, next: "approval" },
        { id: "approval", type: "approval", onSuccess: "poll", onFailure: "failed" },
        { id: "poll", type: "poll", config: { connectorId: "conn_1", intervalSeconds: 5 }, onSuccess: "done", onFailure: "failed" },
        { id: "done", type: "terminal", config: { status: "completed" } },
        { id: "failed", type: "terminal", config: { status: "failed" } },
      ],
    });
    expect(definition.states).toHaveLength(7);
    expect(transitionFor(definition.states[0], "success")).toBe("tool");
    expect(transitionFor(definition.states[0], "failure")).toBe("failed");
  });

  it("rejects duplicate ids, missing targets, and invalid waits", () => {
    expect(() => parseWorkflowDefinition({ start: "a", states: [{ id: "a", type: "approval" }, { id: "a", type: "approval" }] }))
      .toThrow("duplicate_state:a");
    expect(() => parseWorkflowDefinition({ start: "a", states: [{ id: "a", type: "approval", next: "missing" }] }))
      .toThrow("transition_target_missing:a:missing");
    expect(() => parseWorkflowDefinition({ start: "a", states: [{ id: "a", type: "wait", config: { durationSeconds: 0 } }] }))
      .toThrow("wait_duration_invalid:a");
  });
});

describe("workflow templates", () => {
  it("preserves exact expression types and interpolates strings", () => {
    const result = resolveWorkflowTemplate(
      { amount: "$input.amount", note: "Deal $input.deal.id by $steps.lookup.data.owner" },
      { input: { amount: 42, deal: { id: "D-7" } }, steps: { lookup: { data: { owner: "Ada" } } } },
    );
    expect(result).toEqual({ amount: 42, note: "Deal D-7 by Ada" });
  });
});
