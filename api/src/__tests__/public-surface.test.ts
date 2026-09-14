import { describe, it, expect } from "vitest";
import {
  PUBLIC_AGENT_FIELDS,
  publicAgentView,
  publicRunSummary,
  publicRunView,
  publicWorkflowRunView,
  spectatorGoalView,
  spectatorTaskView,
} from "../lib/agent-view.js";
import { filterForSpectator, SPECTATOR_MAX_ITEM_AGE_MS } from "../lib/needs-you-copy.js";
import { clampLimit, decodeCursor, encodeCursor, takePage, MAX_PAGE_LIMIT } from "../lib/list-page.js";
import { contentTypeForName, isScrubbableTextType } from "../lib/content-type.js";
import { scrubInternalPaths } from "../lib/public-text.js";

// Everything here guards one promise: an anonymous visitor to
// live.circlechat.co gets the story, never the machinery. The P0 that prompted
// it was GET /api/agents/:id returning 269 KB — 282 KB of which was
// `recentRuns[].contextJson`, the agents' assembled prompt packets (memory
// blocks, the planner ledger, previousRunErrors, verbatim inbox excerpts and
// the NAMES of blocked credentials) — to anyone who asked.

// The exact shape the issue calls for: id, status, trigger, timing, summary.
const RUN_KEYS = ["id", "trigger", "status", "startedAt", "finishedAt", "durationSec", "summary"];

// Keys that must never appear in anything served to a spectator, whatever the
// route. Asserted as a set so a new leak of the same class fails a test rather
// than shipping.
const FORBIDDEN = [
  "contextJson",
  "traceJson",
  "resultJson",
  "steerJson",
  "followupJson",
  "errorText",
  "inputJson",
  "outputJson",
  "configJson",
  "botToken",
  "callbackUrl",
  "costUsd",
  "tokensEst",
];

function fullRun() {
  return {
    id: "run_abc123",
    agentId: "a_1",
    trigger: "scheduled",
    status: "ok",
    // 45 KB of prompt packet in production.
    contextJson: {
      memoryBlocks: { team_whiteboard: "VERCEL_TOKEN (blocks task_x since 2026-07-06)" },
      previousRunErrors: ["post_message rejected: tool_call_syntax"],
      inbox: [{ id: "m_1", bodyMd: "internal chatter" }],
    },
    resultJson: { applied: 2, errors: [] },
    traceJson: ["post_message ok", "update_task ok"],
    conversationId: "c_1",
    startedAt: new Date("2026-09-14T10:00:00Z"),
    finishedAt: new Date("2026-09-14T10:00:12Z"),
    costUsd: 0.42,
    tokensEst: 9000,
    errorText: null,
    steerJson: [{ text: "focus on the landing page" }],
    followupJson: [],
    ownerMemberId: null,
  };
}

describe("publicRunView — the P0 projection", () => {
  it("returns exactly the allowed keys", () => {
    expect(Object.keys(publicRunView(fullRun())).sort()).toEqual([...RUN_KEYS].sort());
  });

  it("carries none of the internal payloads", () => {
    const view = publicRunView(fullRun()) as unknown as Record<string, unknown>;
    for (const key of FORBIDDEN) expect(view).not.toHaveProperty(key);
  });

  it("does not leak context through JSON serialization either", () => {
    // The real regression would be a nested object still carrying the packet,
    // which a key-by-key check on the top level would miss.
    const json = JSON.stringify(publicRunView(fullRun()));
    expect(json).not.toContain("VERCEL_TOKEN");
    expect(json).not.toContain("previousRunErrors");
    expect(json).not.toContain("memoryBlocks");
    expect(json).not.toContain("tool_call_syntax");
  });

  it("computes duration from the timestamps", () => {
    expect(publicRunView(fullRun()).durationSec).toBe(12);
  });

  it("leaves duration null while the run is unfinished", () => {
    expect(publicRunView({ ...fullRun(), finishedAt: null }).durationSec).toBeNull();
  });
});

describe("publicRunSummary", () => {
  it("counts applied actions", () => {
    expect(publicRunSummary({ id: "r", trigger: "t", status: "ok", startedAt: new Date(), resultJson: { applied: 3 } })).toBe(
      "3 actions applied.",
    );
  });

  it("uses the singular for one action", () => {
    expect(publicRunSummary({ id: "r", trigger: "t", status: "ok", startedAt: new Date(), resultJson: { applied: 1 } })).toBe(
      "1 action applied.",
    );
  });

  it("explains a skip in plain English", () => {
    expect(
      publicRunSummary({ id: "r", trigger: "t", status: "ok", startedAt: new Date(), resultJson: { skipped: "no_activity" } }),
    ).toBe("Skipped — nothing new to look at.");
  });

  it("falls back for a skip reason it does not know", () => {
    expect(
      publicRunSummary({ id: "r", trigger: "t", status: "ok", startedAt: new Date(), resultJson: { skipped: "some_new_gate" } }),
    ).toBe("Skipped — nothing to do.");
  });

  it("never echoes the run's error text", () => {
    const summary = publicRunSummary({
      id: "r",
      trigger: "t",
      status: "failed",
      startedAt: new Date(),
      resultJson: { errors: ["HERMES_WRITE_SAFE_ROOT=/opt/data denied the write"] },
    });
    expect(summary).toBe("The run did not finish.");
    expect(summary).not.toContain("HERMES");
  });
});

describe("publicWorkflowRunView", () => {
  it("drops the run's input and output payloads", () => {
    const view = publicWorkflowRunView({
      id: "wr_1",
      workflowId: "wf_1",
      status: "completed",
      startedAt: new Date("2026-09-14T10:00:00Z"),
      finishedAt: new Date("2026-09-14T10:01:00Z"),
    }) as unknown as Record<string, unknown>;
    expect(view).not.toHaveProperty("inputJson");
    expect(view).not.toHaveProperty("outputJson");
    expect(view.durationSec).toBe(60);
  });
});

describe("publicAgentView", () => {
  it("keeps only the identity fields", () => {
    const view = publicAgentView({
      id: "a_1",
      handle: "nova",
      name: "Nova",
      status: "idle",
      model: "auto",
      configJson: { baseUrl: "https://gateway.internal" },
      botToken: "cc_abc…wxyz",
      callbackUrl: "https://agent.internal/hook",
      scopes: ["channels.read"],
      budgetUsdMonth: 25,
    });
    for (const key of Object.keys(view)) {
      expect(PUBLIC_AGENT_FIELDS as readonly string[]).toContain(key);
    }
    expect(view).not.toHaveProperty("configJson");
    expect(view).not.toHaveProperty("botToken");
    expect(view).not.toHaveProperty("budgetUsdMonth");
  });
});

describe("spectator board/goal projections", () => {
  it("drops the judge's rationale but keeps the verdict", () => {
    const task = spectatorTaskView({
      id: "task_1",
      title: "Ship the dashboard",
      verification: { verdict: "fail", score: 0.4, rationale: "the rubric asked for /workspace/report.md" },
    });
    expect(task.verification).toEqual({ verdict: "fail", score: 0.4 });
  });

  it("leaves a task with no verdict alone", () => {
    const task = { id: "task_2", title: "Draft copy", verification: null };
    expect(spectatorTaskView(task)).toEqual(task);
  });

  it("drops planner bookkeeping from a goal", () => {
    const goal = spectatorGoalView({
      id: "goal_1",
      title: "Launch",
      status: "in_progress",
      planAttempts: 4,
      lastPlanError: "plan_generation_failed",
    });
    expect(goal).not.toHaveProperty("lastPlanError");
    expect(goal).not.toHaveProperty("planAttempts");
    expect(goal.title).toBe("Launch");
  });
});

describe("needs-you: the spectator queue", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  const queue = [
    { kind: "approval", createdAt: hoursAgo(3), targetId: "ap_1" },
    { kind: "task_review", createdAt: hoursAgo(10), targetId: "task_1" },
    // 72 days without movement — the live queue's oldest nag.
    { kind: "stalled_goal", createdAt: hoursAgo(72 * 24), targetId: "goal_1" },
    { kind: "stalled_goal", createdAt: hoursAgo(1), targetId: "goal_2" },
    { kind: "verification_failed", createdAt: hoursAgo(2), targetId: "task_verified" },
    { kind: "verification_failed", createdAt: hoursAgo(2), targetId: "task_empty" },
    { kind: "workflow_failed", createdAt: hoursAgo(100), targetId: "wr_1" },
  ];

  it("removes every stalled-goal nag, however fresh", () => {
    const out = filterForSpectator(queue, new Set(), now);
    expect(out.some((i) => i.kind === "stalled_goal")).toBe(false);
  });

  it("ages items out after 72 hours", () => {
    const out = filterForSpectator(queue, new Set(), now);
    expect(out.map((i) => i.targetId)).not.toContain("wr_1");
    expect(SPECTATOR_MAX_ITEM_AGE_MS).toBe(72 * 3_600_000);
  });

  it("suppresses a failed verification whose card has a verified deliverable", () => {
    const out = filterForSpectator(queue, new Set(["task_verified"]), now);
    const ids = out.map((i) => i.targetId);
    expect(ids).not.toContain("task_verified");
    // The one with nothing on disk is a real ask and stays.
    expect(ids).toContain("task_empty");
  });

  it("keeps the items a visitor should see", () => {
    expect(filterForSpectator(queue, new Set(["task_verified"]), now).map((i) => i.targetId)).toEqual([
      "ap_1",
      "task_1",
      "task_empty",
    ]);
  });
});

describe("list pagination", () => {
  it("defaults, clamps and floors the limit", () => {
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit("25")).toBe(25);
    expect(clampLimit(9999)).toBe(MAX_PAGE_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit("not a number")).toBe(100);
  });

  it("round-trips a cursor", () => {
    const parts = ["in_progress", 12.5, "2026-09-14T10:00:00.000Z", "task_abc"];
    expect(decodeCursor(encodeCursor(parts), 4)).toEqual(parts);
  });

  it("ignores a cursor of the wrong arity or shape", () => {
    expect(decodeCursor(encodeCursor(["a", "b"]), 4)).toBeNull();
    expect(decodeCursor("not-base64-json", 2)).toBeNull();
    expect(decodeCursor(undefined, 2)).toBeNull();
    expect(decodeCursor(encodeCursor([]), 0)).toEqual([]);
  });

  it("uses the extra row only to prove there is another page", () => {
    expect(takePage([1, 2, 3], 2)).toEqual({ page: [1, 2], hasMore: true });
    expect(takePage([1, 2], 2)).toEqual({ page: [1, 2], hasMore: false });
  });
});

describe("content types are derived from the name, not the caller", () => {
  it("gives every .md the same type", () => {
    // Live had these three on nine .md attachments.
    expect(contentTypeForName("notes.md", "application/octet-stream")).toBe("text/markdown; charset=utf-8");
    expect(contentTypeForName("notes.md", "text/plain")).toBe("text/markdown; charset=utf-8");
    expect(contentTypeForName("notes.md")).toBe("text/markdown; charset=utf-8");
  });

  it("works on a storage key as well as a bare name", () => {
    expect(contentTypeForName("u/7ctfrmaxi5ie2u5itnaw/backend-restart-verification-2026-09-09.md")).toBe(
      "text/markdown; charset=utf-8",
    );
  });

  it("falls back to a specific declared type only for unknown extensions", () => {
    expect(contentTypeForName("archive.7z", "application/x-7z-compressed")).toBe("application/x-7z-compressed");
    expect(contentTypeForName("mystery", "application/octet-stream")).toBe("application/octet-stream");
    expect(contentTypeForName("mystery")).toBe("application/octet-stream");
  });

  it("knows which bodies the public read path may rewrite", () => {
    expect(isScrubbableTextType("text/markdown; charset=utf-8")).toBe(true);
    expect(isScrubbableTextType("text/html; charset=utf-8")).toBe(true);
    expect(isScrubbableTextType("image/png")).toBe(false);
    expect(isScrubbableTextType("application/pdf")).toBe(false);
  });
});

describe("public read-path scrub for served artifact bodies", () => {
  it("reduces container paths to the filename", () => {
    expect(scrubInternalPaths("Manifest at /workspace/auditor_manifest_sha256.json is current.")).toBe(
      "Manifest at auditor_manifest_sha256.json is current.",
    );
  });

  it("handles the /opt/data mount and a backticked path", () => {
    expect(scrubInternalPaths("See `/opt/data/workspace/projects/showcase/status.md` for detail.")).toBe(
      "See `status.md` for detail.",
    );
  });

  it("drops a bare mount point entirely", () => {
    expect(scrubInternalPaths("Everything lives under /workspace/ now.")).toBe("Everything lives under now.");
  });

  it("removes environment-variable assignments", () => {
    expect(scrubInternalPaths("Set VERIFY_FAIL_MODE=hold to reproduce.").trim()).toBe("Set to reproduce.");
  });

  it("leaves ordinary prose and real URLs untouched", () => {
    const text = "# Report\n\nThe dashboard is live at https://example.com/live and the numbers check out.";
    expect(scrubInternalPaths(text)).toBe(text);
  });

  it("preserves line structure so markdown still renders", () => {
    const text = "# Title\n\n- one\n- two\n";
    expect(scrubInternalPaths(text)).toBe(text);
  });
});
