import { describe, it, expect } from "vitest";
import { isAutoReplayable } from "../agents/executor.js";

// #8: an approved gated executor action is auto-replayed server-side; a
// request_approval for external work (or any non-executor payload) is not.

describe("isAutoReplayable", () => {
  it("accepts executor actions stored on a gated approval", () => {
    expect(isAutoReplayable({ type: "post_message", conversation_id: "c_1", body_md: "hi" })).toBe(true);
    expect(isAutoReplayable({ type: "update_task", task_id: "task_1", status: "done" })).toBe(true);
    expect(isAutoReplayable({ type: "share_to_task", task_id: "task_1", files: [] })).toBe(true);
  });

  it("rejects a request_approval payload (external work the agent must do)", () => {
    expect(isAutoReplayable({ type: "request_approval", scope: "deploy", action: "ship it" })).toBe(false);
  });

  it("rejects call_tool (a no-op record) and unknown/empty payloads", () => {
    expect(isAutoReplayable({ type: "call_tool", name: "x" })).toBe(false);
    expect(isAutoReplayable({})).toBe(false);
    expect(isAutoReplayable(null)).toBe(false);
    expect(isAutoReplayable({ type: 123 })).toBe(false);
  });
});
