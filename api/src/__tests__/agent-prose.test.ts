import { describe, it, expect } from "vitest";
import {
  applyProseRewrites,
  sanitizeAgentProse,
  checkReplyBody,
  guardRejectHint,
} from "../agents/reply-guard.js";
import { redactDeleted } from "../lib/deleted-rows.js";
import { stalledDetail } from "../lib/needs-you-copy.js";
import { publicAgentView } from "../lib/agent-view.js";

// Every string quoted here is verbatim from a live workspace: an agent talking
// about its own container instead of the work. The sanitizer's job is to keep
// the sentence and drop the machinery.

describe("sanitizeAgentProse rewrites container paths", () => {
  it("keeps the sentence and reduces the path to a filename", () => {
    const r = sanitizeAgentProse(
      "I can't write to /workspace/tmp (outside HERMES_WRITE_SAFE_ROOT), so I'll deliver the draft as a card comment instead.",
    );
    expect(r.text).not.toContain("/workspace");
    expect(r.text).not.toContain("HERMES_WRITE_SAFE_ROOT");
    expect(r.text).toContain("the runtime");
    expect(r.text).toContain("so I'll deliver the draft");
  });

  it("reduces every absolute runtime path in a status line", () => {
    const r = sanitizeAgentProse(
      "server.js is persisted on shared disk at /workspace/backend/server.js and the backend is running from /opt/data/workspace/backend/ … ready for @nova's flip to done.",
    );
    expect(r.text).not.toMatch(/\/workspace|\/opt\/data/);
    expect(r.text).toContain("`server.js`");
    expect(r.text).toContain("ready for @nova's move to done.");
    // The trailing-slash directory leaves nothing behind.
    expect(r.text).toContain("running from …");
  });

  it("leaves paths inside a code fence alone", () => {
    const body = "Run this:\n```\ncat /workspace/report.md\n```\nThen review it.";
    const r = sanitizeAgentProse(body);
    expect(r.text).toContain("cat /workspace/report.md");
    expect(r.text).toContain("Then review it.");
  });

  it("bare /workspace with no filename leaves nothing behind", () => {
    const r = sanitizeAgentProse("The files live under /workspace and are synced nightly.");
    expect(r.text).not.toContain("/workspace");
    expect(r.text).toContain("The files live under and are synced nightly.");
  });
});

describe("sanitizeAgentProse removes local endpoints and ports", () => {
  it("localhost URLs become 'the server'", () => {
    const r = sanitizeAgentProse("The preview is at http://localhost:3000/dashboard — take a look.");
    expect(r.text).not.toMatch(/localhost|3000/);
    expect(r.text).toContain("the server");
  });

  it("127.0.0.1 with a port too", () => {
    const r = sanitizeAgentProse("Health check passes against 127.0.0.1:8080.");
    expect(r.text).not.toMatch(/127\.0\.0\.1|8080/);
  });

  it("'running on port 3000' loses the port", () => {
    const r = sanitizeAgentProse("The API is running on port 3000 and answering.");
    expect(r.text).toBe("The API is running and answering.");
  });
});

describe("sanitizeAgentProse rewrites harness vocabulary", () => {
  const cases: Array<[string, RegExp, RegExp]> = [
    ["Waiting on the review flip before I start the next card.", /review flip/i, /\breview\b/],
    ["@iris flipped it to done this morning.", /flipped/i, /moved it to done/],
    ["I did three things this turn.", /this turn/i, /today/],
    ["The heartbeat found nothing new.", /heartbeat/i, /status check/],
    ["The auto-verifier rejected the draft.", /verifier/i, /automated check/],
    ["Use share_to_task to ship the file.", /share_to_task/, /attach to the card/],
    ["Logged it in project_note for the record.", /project_note/, /the project notes/],
    ["Left a task_comment with the numbers.", /task_comment/, /a card comment/],
    ["HERMES_WRITE_SAFE_ROOT is set to the data mount.", /HERMES_/, /the runtime/],
  ];
  for (const [input, gone, present] of cases) {
    it(`rewrites: ${input.slice(0, 40)}…`, () => {
      const out = sanitizeAgentProse(input).text;
      expect(out).not.toMatch(gone);
      expect(out).toMatch(present);
    });
  }

  it("does not rewrite inside a fence", () => {
    const out = sanitizeAgentProse("Call it like:\n```\nshare_to_task(task_id=\"x\")\n```\nDone.").text;
    expect(out).toContain('share_to_task(task_id="x")');
  });
});

describe("sanitizeAgentProse rejects bodies that are only machinery", () => {
  it("a lone gateway warning", () => {
    const r = sanitizeAgentProse("WARNING gateway.run: No env user allowlists configured.");
    expect(r.text).toBe("");
    expect(r.emptyReason).toBe("runtime_log_line");
  });

  it("a lone tool_call block", () => {
    const r = sanitizeAgentProse("<tool_call>\n<function=read_file>\n<parameter=path>x</parameter>\n</function>\n</tool_call>");
    expect(r.text).toBe("");
    expect(r.emptyReason).toBe("tool_call_markup");
  });

  it("the invalid-tool-call notice", () => {
    const r = sanitizeAgentProse("Model generated invalid tool call: missing required argument.");
    expect(r.emptyReason).toBe("invalid_tool_call_notice");
  });

  it("an OUTPUT_ERROR marker", () => {
    const r = sanitizeAgentProse("**OUTPUT_ERROR**");
    expect(r.emptyReason).toBe("output_error_notice");
  });

  it("a misspelled heartbeat sentinel", () => {
    const r = sanitizeAgentProse("HEARTBERAT_OK");
    expect(r.emptyReason).toBe("heartbeat_leaked");
  });

  it("a model-breakdown token", () => {
    const r = sanitizeAgentProse("<｜DSML｜");
    expect(r.emptyReason).toBe("model_breakdown_token");
  });

  it("the task-only-mode banner", () => {
    const r = sanitizeAgentProse("HERMES IS IN TASK-ONLY MODE — no conversation is attached.");
    expect(r.emptyReason).toBe("task_only_mode_banner");
  });

  it("a bare section header with nothing under it", () => {
    const r = sanitizeAgentProse("**Status Update:**");
    expect(r.text).toBe("");
    expect(r.emptyReason).toBe("empty_body");
  });

  it("but keeps a section header that HAS content", () => {
    const r = sanitizeAgentProse("**Status Update:**\nThe copy is drafted and on the card.");
    expect(r.emptyReason).toBeUndefined();
    expect(r.text).toContain("The copy is drafted");
  });
});

describe("sanitizeAgentProse strips machinery mixed into real prose", () => {
  it("keeps the prose either side of a gateway log line", () => {
    const r = sanitizeAgentProse(
      "Draft is on the card.\nWARNING gateway.run: No env user allowlists configured.\nReview when you can.",
    );
    expect(r.text).not.toContain("gateway.run");
    expect(r.text).toContain("Draft is on the card.");
    expect(r.text).toContain("Review when you can.");
    expect(r.stripped).toContain("runtime_log_line");
  });

  it("keeps the 'Full update on the task card:' pointer", () => {
    const r = sanitizeAgentProse("Shipped the copy. Full update on the task card:");
    expect(r.text).toContain("Full update on the task card:");
  });
});

describe("checkReplyBody stores the sanitized body", () => {
  it("a real reply with a path is accepted, cleaned", () => {
    const r = checkReplyBody(
      "server.js is persisted on shared disk at /workspace/backend/server.js — ready for @nova's flip to done.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bodyMd).not.toContain("/workspace");
      expect(r.bodyMd).toContain("move to done");
    }
  });

  it("a body that is only a gateway warning is refused with a hint", () => {
    const r = checkReplyBody("WARNING gateway.run: No env user allowlists configured.");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("runtime_log_line");
      expect(guardRejectHint(r.reason)).toMatch(/diagnostics/i);
    }
  });

  it("the canonical HEARTBEAT_OK sentinel is still rejected, not rewritten", () => {
    const r = checkReplyBody("HEARTBEAT_OK");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("heartbeat_leaked");
  });

  it("a typed-out action call is still rejected (rewrites don't disarm the guard)", () => {
    const r = checkReplyBody('task_comment(task_id="task_abcdefghijkl", body_md="hi")');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("tool_call_syntax");
  });
});

describe("applyProseRewrites is pure", () => {
  it("leaves ordinary prose untouched", () => {
    const s = "The landing page copy is drafted and waiting for a second pair of eyes.";
    expect(applyProseRewrites(s)).toBe(s);
  });
});

describe("redactDeleted", () => {
  it("blanks the body and attachments of a soft-deleted row", () => {
    const row = {
      id: "m_1",
      bodyMd: "the secret original text",
      attachmentsJson: [{ key: "u/x/y.png" }],
      deletedAt: new Date(),
    };
    const out = redactDeleted(row);
    expect(out.bodyMd).toBe("");
    expect(out.attachmentsJson).toEqual([]);
    expect(out.id).toBe("m_1");
  });

  it("returns a live row unchanged", () => {
    const row = { id: "m_2", bodyMd: "hello", attachmentsJson: [], deletedAt: null };
    expect(redactDeleted(row)).toBe(row);
  });
});

describe("needs-you stalled goal detail", () => {
  it("reads as a date, not planner bookkeeping", () => {
    expect(stalledDetail(new Date("2026-09-03T10:00:00Z"))).toBe("No movement since 3 Sep.");
  });
});

describe("publicAgentView", () => {
  it("keeps identity fields and drops the wiring", () => {
    const row = {
      id: "a_1",
      handle: "nova",
      name: "Nova",
      avatarColor: "blue",
      title: "Researcher",
      brief: "Researches topics.",
      status: "idle",
      memberId: "m_1",
      model: "claude",
      kind: "hermes",
      adapter: "socket",
      configJson: { baseUrl: "http://internal:8080" },
      scopes: ["channels.read"],
      botToken: "cc_***",
      callbackUrl: "http://internal/hook",
      heartbeatIntervalSec: 60,
      budgetUsdMonth: 10,
      pauseReason: null,
    };
    const out = publicAgentView(row) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(
      ["avatarColor", "brief", "handle", "id", "memberId", "model", "name", "status", "title"],
    );
  });
});
