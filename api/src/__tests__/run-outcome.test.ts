import { describe, it, expect } from "vitest";
import { classifyRunOutcome, heartbeatBackoffMs, RUNAWAY_BANNER_RE } from "../lib/run-outcome.js";

// On the fishbowl every one of 1,466 runs/week was status=ok, error_text=null,
// while the bridge logged "skip (empty/crashed reply)" and agents posted
// "⚠️ Reached maximum iterations (20)". These classify those outcomes.

const post = (body_md: string) => ({ type: "post_message", conversation_id: "c_1", body_md });

describe("classifyRunOutcome", () => {
  it("HEARTBEAT_OK is an idle ok run, not productive", () => {
    const c = classifyRunOutcome("HEARTBEAT_OK", { actionsApplied: 0, errors: [] });
    expect(c.status).toBe("ok");
    expect(c.productive).toBe(false);
  });

  it("applied actions → productive ok", () => {
    const c = classifyRunOutcome({ actions: [post("hello")] }, { actionsApplied: 1, errors: [] });
    expect(c).toEqual({ status: "ok", productive: true, errorText: null });
  });

  it("an explicit runtime error (e.g. empty_reply from the bridge) fails the run", () => {
    const c = classifyRunOutcome({ actions: [], error: "empty_reply" }, { actionsApplied: 0, errors: [] });
    expect(c.status).toBe("failed");
    expect(c.errorText).toBe("empty_reply");
  });

  it("the bridge's catch-all error trace fails the run even though it posted a banner", () => {
    const c = classifyRunOutcome(
      {
        actions: [post("⚠️ Ben error: `spawn hermes ENOENT`")],
        trace: ["ben error: spawn hermes ENOENT"],
      },
      { actionsApplied: 1, errors: [] },
    );
    expect(c.status).toBe("failed");
    expect(c.errorText).toBe("bridge_error: spawn hermes ENOENT");
  });

  it("a runaway max-iterations banner fails the run", () => {
    expect(RUNAWAY_BANNER_RE.test("⚠️ Reached maximum iterations (20)")).toBe(true);
    const c = classifyRunOutcome(
      { actions: [post("Progress so far…\n\n⚠️ Reached maximum iterations (20)")] },
      { actionsApplied: 1, errors: [] },
    );
    expect(c.status).toBe("failed");
    expect(c.errorText).toBe("runaway_max_iterations");
  });

  it("every action rejected → failed with the first rejection reason", () => {
    const c = classifyRunOutcome(
      { actions: [post("x"), post("y")] },
      { actionsApplied: 0, errors: ["post_message rejected: cot_leak. hint", "post_message rejected: duplicate_of_recent"] },
    );
    expect(c.status).toBe("failed");
    expect(c.errorText).toBe("all_actions_rejected: post_message rejected: cot_leak. hint");
  });

  it("some rejected but some applied is still ok (errors stay in result_json)", () => {
    const c = classifyRunOutcome(
      { actions: [post("x"), post("y")] },
      { actionsApplied: 1, errors: ["post_message rejected: duplicate_of_recent"] },
    );
    expect(c.status).toBe("ok");
    expect(c.productive).toBe(true);
  });

  it("no actions at all (bridge returned an empty list) is idle, not failed", () => {
    const c = classifyRunOutcome({ actions: [] }, { actionsApplied: 0, errors: [] });
    expect(c.status).toBe("ok");
    expect(c.productive).toBe(false);
  });
});

describe("heartbeatBackoffMs", () => {
  const base = 60 * 60 * 1000; // hourly heartbeat
  const cap = 6 * 60 * 60 * 1000;

  it("does not back off on the first quiet beat", () => {
    expect(heartbeatBackoffMs(0, base, cap)).toBe(0);
    expect(heartbeatBackoffMs(1, base, cap)).toBe(0);
  });

  it("doubles from the second consecutive non-productive run", () => {
    expect(heartbeatBackoffMs(2, base, cap)).toBe(2 * base);
    expect(heartbeatBackoffMs(3, base, cap)).toBe(4 * base);
  });

  it("caps", () => {
    expect(heartbeatBackoffMs(4, base, cap)).toBe(cap);
    expect(heartbeatBackoffMs(50, base, cap)).toBe(cap);
  });

  it("a cap below the base interval clamps to the base, never below it", () => {
    expect(heartbeatBackoffMs(2, 5_000, 1_000)).toBe(5_000);
  });
});
