import { describe, expect, it } from "vitest";
import { applyCounted, classifyRunOutcome } from "../lib/run-outcome.js";

describe("applyCounted", () => {
  it("counts an action that applied cleanly", async () => {
    const out = { actionsApplied: 0, errors: [] as string[] };
    const applied = await applyCounted(out, async () => {});
    expect(applied).toBe(true);
    expect(out.actionsApplied).toBe(1);
  });

  it("does not count an action the handler rejected by pushing an error", async () => {
    const out = { actionsApplied: 0, errors: [] as string[] };
    const applied = await applyCounted(out, async () => {
      out.errors.push("task_comment rejected: heartbeat_leaked.");
    });
    expect(applied).toBe(false);
    expect(out.actionsApplied).toBe(0);
  });

  it("makes a turn whose only action was rejected non-productive", async () => {
    const out = { actionsApplied: 0, errors: [] as string[] };
    await applyCounted(out, async () => {
      out.errors.push("task_comment rejected: heartbeat_leaked.");
    });
    const cls = classifyRunOutcome({ actions: [{ type: "task_comment" }] }, out);
    expect(cls.productive).toBe(false);
    expect(cls.status).toBe("failed");
  });

  it("keeps a turn productive when one action applied and another was rejected", async () => {
    const out = { actionsApplied: 0, errors: [] as string[] };
    await applyCounted(out, async () => {});
    await applyCounted(out, async () => {
      out.errors.push("task_comment skipped: near-duplicate");
    });
    expect(out.actionsApplied).toBe(1);
    const cls = classifyRunOutcome({ actions: [{ type: "update_task" }, { type: "task_comment" }] }, out);
    expect(cls.productive).toBe(true);
  });
});
