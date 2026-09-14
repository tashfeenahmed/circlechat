import { describe, it, expect, beforeAll } from "vitest";
import { classifyRunOutcome } from "../lib/run-outcome.js";

// Live: /opt/hermes-homes-live/.hermes-miles/logs/gateway-exit-diag.log had 212
// `exit_nonzero` entries. The original diagnosis here — s6 interrupting an
// in-flight cron job — was wrong. gateway.log shows every one of those
// shutdowns draining nothing (`cron_at_start=0`, `timed_out=False`, teardown
// 0.21 s) and then "Exiting with code 1 (signal-initiated shutdown without
// restart request) so systemd Restart=on-failure can revive the gateway":
// Hermes reports a signal-stop as a failure on purpose. It is also invisible
// to this bridge, because the gateway is an s6-supervised background service
// and only the container's CMD sets the `docker run` exit code.
//
// What WAS a bridge bug: nothing stopped two turns for the same agent from
// running concurrently against one HERMES_HOME.

type Bridge = {
  gatewayExitError: (exitCode: number | null, signal: string | null) => string | null;
  claimAgentSlot: (
    handle: string,
    trigger: string,
    now?: number,
  ) => { ok: true; done: () => void } | { ok: false; droppable: boolean; reason: string };
  buildHermesSpawn: (
    home: string,
    args: string[],
    envExtras?: Record<string, string>,
  ) => { cmd: string; args: string[] };
};

let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as unknown as Bridge;
});

describe("gatewayExitError", () => {
  it("a clean exit is not an error", () => {
    expect(bridge.gatewayExitError(0, null)).toBeNull();
  });

  it("a non-zero exit is an error even though the agent produced text first", () => {
    expect(bridge.gatewayExitError(1, null)).toBe("gateway_exit_nonzero: exit 1");
    expect(bridge.gatewayExitError(137, null)).toBe("gateway_exit_nonzero: exit 137");
  });

  it("a signal kill reports the signal — that is the dirty-shutdown case", () => {
    expect(bridge.gatewayExitError(null, "SIGTERM")).toBe("gateway_interrupted: killed by SIGTERM");
    expect(bridge.gatewayExitError(143, "SIGTERM")).toBe("gateway_interrupted: killed by SIGTERM");
  });

  it("an unknown exit code is not invented as a failure", () => {
    expect(bridge.gatewayExitError(null, null)).toBeNull();
  });
});

describe("the worker's classification of a failed container", () => {
  it("is a FAILED run, not an ok one, even with actions applied", () => {
    const err = bridge.gatewayExitError(1, null)!;
    const cls = classifyRunOutcome(
      { actions: [{ type: "post_message", conversation_id: "c_1", body_md: "done" }], error: err },
      { actionsApplied: 1, errors: [] },
    );
    expect(cls.status).toBe("failed");
    expect(cls.errorText).toBe("gateway_exit_nonzero: exit 1");
  });

  it("a runaway banner still wins — it is the more specific diagnosis", () => {
    const cls = classifyRunOutcome(
      { actions: [], error: "runaway_max_iterations" },
      { actionsApplied: 0, errors: [] },
    );
    expect(cls.errorText).toBe("runaway_max_iterations");
  });
});

describe("claimAgentSlot", () => {
  it("lets a free agent run, and blocks a second turn on the same home", () => {
    const first = bridge.claimAgentSlot("miles", "ambient", 1_000);
    expect(first.ok).toBe(true);
    const second = bridge.claimAgentSlot("miles", "ambient", 61_000);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    // The live collision: 17:21:00 and 17:22:00, 60 s apart.
    expect(second.reason).toContain("60s");
    expect(second.reason).toContain("agent_busy");
    if (first.ok) first.done();
  });

  it("releases the home once the turn is done", () => {
    const first = bridge.claimAgentSlot("nova", "ambient", 0);
    expect(first.ok).toBe(true);
    if (first.ok) first.done();
    expect(bridge.claimAgentSlot("nova", "ambient", 1).ok).toBe(true);
  });

  it("does not let one busy agent block a different agent", () => {
    const m = bridge.claimAgentSlot("iris", "ambient", 0);
    expect(m.ok).toBe(true);
    expect(bridge.claimAgentSlot("ben", "ambient", 0).ok).toBe(true);
    if (m.ok) m.done();
  });

  it("drops stale background beats but reports the triggers someone is waiting on", () => {
    const held = bridge.claimAgentSlot("sam", "mention", 0);
    expect(held.ok).toBe(true);
    for (const t of ["ambient", "scheduled"]) {
      const r = bridge.claimAgentSlot("sam", t, 0);
      if (r.ok) throw new Error("expected busy");
      expect(r.droppable).toBe(true);
    }
    for (const t of ["mention", "dm", "approval_response", "task_assigned"]) {
      const r = bridge.claimAgentSlot("sam", t, 0);
      if (r.ok) throw new Error("expected busy");
      expect(r.droppable).toBe(false);
    }
    if (held.ok) held.done();
  });
});

describe("buildHermesSpawn", () => {
  it("gives the per-run container a real shutdown grace period", () => {
    const spec = bridge.buildHermesSpawn("/opt/hermes-homes/.hermes-miles", ["chat", "-q", "hi"]);
    expect(spec.cmd).toBe("docker");
    const i = spec.args.indexOf("--stop-timeout");
    expect(i).toBeGreaterThan(-1);
    expect(Number(spec.args[i + 1])).toBeGreaterThanOrEqual(30);
    // s6's own knobs; the 3 s default is too short for a service mid-write.
    const envs = spec.args.filter((a) => a.startsWith("S6_"));
    expect(envs.some((a) => a.startsWith("S6_SERVICES_GRACETIME="))).toBe(true);
    expect(envs.some((a) => a.startsWith("S6_KILL_GRACETIME="))).toBe(true);
    for (const e of envs) expect(Number(e.split("=")[1])).toBeGreaterThanOrEqual(30_000);
  });

  it("still mounts the agent home and passes the agent's args through", () => {
    const spec = bridge.buildHermesSpawn("/opt/hermes-homes/.hermes-miles", ["chat", "-q", "hi"], {
      CC_BOT_TOKEN: "cc_x",
    });
    expect(spec.args).toContain("/opt/hermes-homes/.hermes-miles:/opt/data");
    expect(spec.args.slice(-3)).toEqual(["chat", "-q", "hi"]);
    expect(spec.args).toContain("CC_BOT_TOKEN=cc_x");
  });
});
