import { describe, it, expect, vi } from "vitest";
import { shouldRemoveBeforeAdd, clearFinishedJob } from "../lib/queue-dedupe.js";

// On live, two open goals sat unplanned for 70 minutes. Both had a `plan_<id>`
// job in the completed set (a plan that returned early — a deferred plan, or
// one whose LLM gateway was unreachable, neither of which FAILS the job), and
// BullMQ's fixed-jobId check is bare key existence: every 3-minute sweeper
// re-enqueue was discarded as a duplicate. Removing the completed jobs by hand
// unblocked both goals instantly.

describe("shouldRemoveBeforeAdd", () => {
  it("removes a finished job — it is done, and can only block the retry", () => {
    expect(shouldRemoveBeforeAdd("completed")).toBe(true);
    expect(shouldRemoveBeforeAdd("failed")).toBe(true);
  });

  it("keeps in-flight work — that is what the fixed jobId is for", () => {
    expect(shouldRemoveBeforeAdd("waiting")).toBe(false);
    expect(shouldRemoveBeforeAdd("active")).toBe(false);
    expect(shouldRemoveBeforeAdd("delayed")).toBe(false);
    expect(shouldRemoveBeforeAdd("prioritized")).toBe(false);
    expect(shouldRemoveBeforeAdd("waiting-children")).toBe(false);
  });

  it("does nothing for an id BullMQ has no record of", () => {
    expect(shouldRemoveBeforeAdd("unknown")).toBe(false);
    expect(shouldRemoveBeforeAdd(null)).toBe(false);
    expect(shouldRemoveBeforeAdd(undefined)).toBe(false);
    expect(shouldRemoveBeforeAdd("")).toBe(false);
  });
});

function fakeQueue(state: string | null) {
  const remove = vi.fn(async () => undefined);
  const job = state === null ? undefined : { getState: async () => state, remove };
  return {
    remove,
    queue: { name: "goal-plans", getJob: vi.fn(async () => job) },
  };
}

describe("clearFinishedJob", () => {
  it("removes the completed job squatting on the id (the live bug)", async () => {
    const { queue, remove } = fakeQueue("completed");
    await expect(clearFinishedJob(queue, "plan_g1")).resolves.toBe(true);
    expect(queue.getJob).toHaveBeenCalledWith("plan_g1");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("removes a failed job too", async () => {
    const { queue, remove } = fakeQueue("failed");
    await expect(clearFinishedJob(queue, "plan_g1")).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("leaves a debounced (delayed) plan alone, so edits still coalesce", async () => {
    const { queue, remove } = fakeQueue("delayed");
    await expect(clearFinishedJob(queue, "plan_g1")).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("never yanks a job out from under a running worker", async () => {
    const { queue, remove } = fakeQueue("active");
    await expect(clearFinishedJob(queue, "plan_g1")).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("is a no-op when the id is free", async () => {
    const { queue, remove } = fakeQueue(null);
    await expect(clearFinishedJob(queue, "plan_g1")).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("swallows a redis failure rather than blocking the enqueue behind it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = {
      name: "goal-plans",
      getJob: async () => {
        throw new Error("Connection is closed.");
      },
    };
    await expect(clearFinishedJob(queue, "plan_g1")).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
