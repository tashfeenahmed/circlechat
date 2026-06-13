import { describe, it, expect } from "vitest";
import { shouldContinue } from "../agents/continuation.js";
import type { AgentAction } from "../agents/executor.js";

const a = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as AgentAction;

describe("shouldContinue (agent follow-up turn rule)", () => {
  it("continues after a progress action under the cap", () => {
    expect(shouldContinue([a("decompose_goal", { goal_id: "g1" })], 0, 2)).toBe(true);
    expect(shouldContinue([a("update_task", { task_id: "t1", status: "in_progress" })], 0, 2)).toBe(true);
    expect(shouldContinue([a("share_to_task", { task_id: "t1" })], 1, 2)).toBe(true);
  });

  it("does not continue on pure chat / reactions", () => {
    expect(shouldContinue([a("post_message", { conversation_id: "c1", body_md: "hi" })], 0, 2)).toBe(false);
    expect(shouldContinue([a("react", { message_id: "m1", emoji: "👍" })], 0, 2)).toBe(false);
  });

  it("does not continue when the agent parked on an approval", () => {
    // Even alongside a progress action, request_approval means it's waiting on a human.
    expect(
      shouldContinue([a("create_task", { title: "x" }), a("request_approval", { scope: "deploy", action: "ship" })], 0, 2),
    ).toBe(false);
  });

  it("stops at the chain-depth cap", () => {
    expect(shouldContinue([a("create_task", { title: "x" })], 2, 2)).toBe(false);
    expect(shouldContinue([a("create_task", { title: "x" })], 3, 2)).toBe(false);
  });

  it("does not continue on an empty action list", () => {
    expect(shouldContinue([], 0, 2)).toBe(false);
  });
});
