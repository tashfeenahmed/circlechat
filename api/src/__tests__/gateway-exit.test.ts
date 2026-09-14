import { describe, it, expect, beforeAll } from "vitest";
import { classifyRunOutcome } from "../lib/run-outcome.js";

// Live: /opt/hermes-homes-live/.hermes-miles/logs/gateway-exit-diag.log had 207
// consecutive `exit_nonzero` entries, each one s6-supervise SIGTERMing the
// gateway 12–55 s into the run with "1 in-flight cron job(s)" — the same job id
// every time, because every dirty shutdown suspended the session and the next
// boot resumed and re-interrupted it. Every one of those runs was recorded in
// agent_runs as status=ok.

type Bridge = {
  gatewayExitError: (exitCode: number | null, signal: string | null) => string | null;
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

describe("the worker's classification of a dirty gateway exit", () => {
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

describe("buildHermesSpawn", () => {
  it("gives the per-run container a real shutdown grace period", () => {
    const spec = bridge.buildHermesSpawn("/opt/hermes-homes/.hermes-miles", ["chat", "-q", "hi"]);
    expect(spec.cmd).toBe("docker");
    const i = spec.args.indexOf("--stop-timeout");
    expect(i).toBeGreaterThan(-1);
    expect(Number(spec.args[i + 1])).toBeGreaterThanOrEqual(30);
    // s6's own knobs — the 3 s default is what interrupted the cron job.
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
