import { describe, it, expect } from "vitest";
import { isPlaceholderId, repairAction, type RepairCtx } from "../agents/action-repair.js";
import type { AgentAction } from "../agents/executor.js";

describe("isPlaceholderId", () => {
  it("flags template placeholders", () => {
    for (const p of ["task_…", "task_<id>", "<id>", "<task_id>", "conversation_id", "task_id", "c_…", "task_", ""]) {
      expect(isPlaceholderId(p)).toBe(true);
    }
  });

  it("does not flag real ids", () => {
    for (const r of ["task_a1b2c3d4e5f6", "c_2xujxy00dgtqpjodmzpd", "m_qdu0tn3mm2b3ktzps4bv"]) {
      expect(isPlaceholderId(r)).toBe(false);
    }
  });
});

const ctx: RepairCtx = { soleOpenTaskId: "task_real123", triggerConversationId: "c_real456" };

describe("repairAction", () => {
  it("rewrites a placeholder task_id to the sole open task", () => {
    const { action, repairs } = repairAction(
      { type: "task_comment", task_id: "task_…", body_md: "done" } as AgentAction,
      ctx,
    );
    expect((action as { task_id: string }).task_id).toBe("task_real123");
    expect(repairs.length).toBe(1);
  });

  it("leaves a real task_id untouched", () => {
    const { action, repairs } = repairAction(
      { type: "update_task", task_id: "task_already_valid_id", status: "review" } as AgentAction,
      ctx,
    );
    expect((action as { task_id: string }).task_id).toBe("task_already_valid_id");
    expect(repairs.length).toBe(0);
  });

  it("does not rewrite a placeholder task_id when there's no sole open task", () => {
    const { action, repairs } = repairAction(
      { type: "task_comment", task_id: "task_…", body_md: "x" } as AgentAction,
      { soleOpenTaskId: null, triggerConversationId: "c_real456" },
    );
    expect((action as { task_id: string }).task_id).toBe("task_…");
    expect(repairs.length).toBe(0);
  });

  it("rewrites a placeholder conversation_id to the trigger conversation", () => {
    const { action, repairs } = repairAction(
      { type: "post_message", conversation_id: "<id>", body_md: "hi" } as AgentAction,
      ctx,
    );
    expect((action as { conversation_id: string }).conversation_id).toBe("c_real456");
    expect(repairs.length).toBe(1);
  });

  it("prefixes a relative file path with /workspace/", () => {
    const { action, repairs } = repairAction(
      { type: "share_to_task", task_id: "task_real123", files: [{ path: "report.md" }] } as AgentAction,
      ctx,
    );
    const files = (action as { files: Array<{ path: string }> }).files;
    expect(files[0].path).toBe("/workspace/report.md");
    expect(repairs.some((r) => r.includes("report.md"))).toBe(true);
  });

  it("leaves an absolute path untouched", () => {
    const { action, repairs } = repairAction(
      { type: "share_files", conversation_id: "c_real456", files: [{ path: "/workspace/a.png" }] } as AgentAction,
      ctx,
    );
    expect((action as { files: Array<{ path: string }> }).files[0].path).toBe("/workspace/a.png");
    expect(repairs.length).toBe(0);
  });

  it("leaves url file entries alone", () => {
    const { action } = repairAction(
      { type: "share_files", conversation_id: "c_real456", files: [{ url: "https://x.com/a.png" }] } as AgentAction,
      ctx,
    );
    expect((action as { files: Array<{ url?: string; path?: string }> }).files[0]).toEqual({ url: "https://x.com/a.png" });
  });
});
