import { describe, it, expect } from "vitest";
import { validateActionShape, type AgentAction } from "../agents/executor.js";

// Schema gate in front of action dispatch: malformed actions become teaching
// errors fed back to the agent instead of silent no-ops (the old applied:0
// mystery). null = valid; a string = the skip reason shown to the agent.

const valid = (a: unknown) => validateActionShape(a as AgentAction) === null;
const error = (a: unknown) => validateActionShape(a as AgentAction);

describe("validateActionShape", () => {
  it("rejects an action with no type", () => {
    expect(error({})).toContain('missing "type"');
    expect(error({ type: "" })).toContain('missing "type"');
  });

  it("accepts unknown types (forward-compatible: executor decides later)", () => {
    expect(valid({ type: "future_action" })).toBe(true);
  });

  it("requires the per-type string fields", () => {
    expect(error({ type: "task_comment", body_md: "hi" })).toContain('"task_id"');
    expect(error({ type: "task_comment", task_id: "task_1" })).toContain('"body_md"');
    expect(valid({ type: "task_comment", task_id: "task_1", body_md: "hi" })).toBe(true);
  });

  it("treats whitespace-only required fields as missing", () => {
    expect(error({ type: "task_comment", task_id: "   ", body_md: "hi" })).toContain('"task_id"');
  });

  it("requires non-empty files on share actions", () => {
    expect(error({ type: "share_to_task", task_id: "task_1" })).toContain('"files"');
    expect(error({ type: "share_to_task", task_id: "task_1", files: [] })).toContain('"files"');
    expect(
      valid({ type: "share_to_task", task_id: "task_1", files: [{ path: "/workspace/a.md" }] }),
    ).toBe(true);
  });

  it("requires at least one payload field on ledger_update", () => {
    expect(error({ type: "ledger_update", goal_id: "goal_1" })).toContain("at least one");
    expect(valid({ type: "ledger_update", goal_id: "goal_1", facts: ["x"] })).toBe(true);
    expect(valid({ type: "ledger_update", goal_id: "goal_1", progress_note: "moving" })).toBe(true);
  });

  it("requires project + note on project_note", () => {
    expect(error({ type: "project_note", note: "hi" })).toContain('"project"');
    expect(error({ type: "project_note", project: "neu" })).toContain('"note"');
    expect(valid({ type: "project_note", project: "neu", note: "shipped the homepage" })).toBe(true);
  });
});
