import { describe, it, expect } from "vitest";
import {
  applyProseRewrites,
  checkReplyBody,
  dedupeConsecutiveLines,
  guardRejectHint,
  sanitizeAgentProse,
} from "../agents/reply-guard.js";
import { isSystemNotice, VERIFICATION_HOLD_PREFIX } from "../lib/tasks-core.js";

// Every body in this file is a real one, taken verbatim (trimmed) from the
// live public workspace. The guard already covered a long list of leak classes;
// these are the ones that were still getting through on 14 Sep 2026.

describe("runtime log lines from any logger, not just gateway.*", () => {
  // Four live messages carried these. None used the `gateway.` logger the
  // original pattern was anchored to.
  const toolsRegistry =
    "WARNING tools.registry: check_fn check_close_terminal_requirements returned False; dependent tools will be unavailable today\n" +
    "WARNING tools.registry: check_fn check_focus_pane_requirements returned False; dependent tools will be unavailable today";

  it("rejects a tools.registry block", () => {
    const r = checkReplyBody(toolsRegistry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("runtime_log_line");
  });

  it("rejects agent.tool_executor with its timestamped output payload", () => {
    const body =
      'WARNING agent.tool_executor: Tool terminal returned error (0.62s): {"output": "[00:27:32] Agent status integration — cron tick"}';
    const r = checkReplyBody(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("runtime_log_line");
  });

  it("still rejects the gateway logger it always caught", () => {
    const r = checkReplyBody("WARNING gateway.run: retrying after 502");
    expect(r.ok).toBe(false);
  });

  it("strips the log block but keeps the real update underneath", () => {
    const out = sanitizeAgentProse(`${toolsRegistry}\nThe nightly export finished and the numbers match.`);
    expect(out.text).toBe("The nightly export finished and the numbers match.");
    expect(out.stripped).toContain("runtime_log_line");
  });

  it("strips a standalone tool-output transcript", () => {
    const out = sanitizeAgentProse(
      "Here is where the run got to.\n[00:27:32] Agent status integration — cron tick\n[00:27:33] Tasks: 31 assigned",
    );
    expect(out.text).toBe("Here is where the run got to.");
    expect(out.stripped).toContain("tool_output_transcript");
  });

  it("leaves a single human timestamp alone", () => {
    const body = "[14:30:00] standup notes are up on the board — nothing blocking.";
    expect(checkReplyBody(body).ok).toBe(true);
  });

  it("never touches a log line inside a code fence", () => {
    const body = "Here's what the container printed:\n```\nWARNING tools.registry: check_fn failed\n```\nI'll look into it.";
    const r = checkReplyBody(body);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bodyMd).toContain("WARNING tools.registry");
  });
});

describe("background-task and subagent notices", () => {
  const bg = "↩ Background task running — I'll resume when it finishes. Keep chatting.";
  const sub = "[subagent-0] ⚡ Interrupted during API call.";

  it("rejects the background-task notice on its own", () => {
    const r = checkReplyBody(bg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("background_task_notice");
  });

  it("rejects the subagent notice on its own", () => {
    const r = checkReplyBody(sub);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("subagent_notice");
  });

  it("rejects a body that is only the two notices (m_mx73q2r303olvosjckkt)", () => {
    expect(checkReplyBody(`${bg}\n${sub}`).ok).toBe(false);
  });

  it("keeps the real content sandwiched between them (m_oq6huw39du2v8xzpbq2w)", () => {
    const body = `${bg}\nAll five review cards verified live today — backend restarted, 7 endpoints 200.\n${sub}`;
    const r = checkReplyBody(body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bodyMd).toBe("All five review cards verified live today — backend restarted, 7 endpoints 200.");
      expect(r.bodyMd).not.toContain("subagent");
      expect(r.bodyMd).not.toContain("Background task");
    }
  });

  it("collapses the doubled copies seen live (m_fiskmrkrqhghgurzowz5)", () => {
    // Both notices arrived twice in one body.
    const out = sanitizeAgentProse(`${bg}\n${bg}\n${sub}\n${sub}\nThe export is ready for review.`);
    expect(out.text).toBe("The export is ready for review.");
  });
});

describe("dedupeConsecutiveLines", () => {
  it("collapses an immediately repeated line", () => {
    expect(dedupeConsecutiveLines("same\nsame\nother")).toBe("same\nother");
  });

  it("leaves a line that recurs later in the body", () => {
    expect(dedupeConsecutiveLines("a\nb\na")).toBe("a\nb\na");
  });

  it("does not collapse blank lines into paragraph-breaking nonsense", () => {
    expect(dedupeConsecutiveLines("one\n\n\ntwo")).toBe("one\n\n\ntwo");
  });
});

describe("container paths written inside backticks", () => {
  it("rewrites a backticked path to its filename (9 of 9 recent leaks)", () => {
    expect(applyProseRewrites("Restarted `node server.js` from `/workspace/backend`.")).toBe(
      "Restarted `node server.js` from `backend`.",
    );
  });

  it("does not emit nested backticks", () => {
    const out = applyProseRewrites("See `/opt/data/workspace/projects/showcase/status.md` for detail.");
    expect(out).toBe("See `status.md` for detail.");
    expect(out).not.toContain("``");
  });

  it("drops a backticked bare mount point, code span and all", () => {
    expect(applyProseRewrites("It lives in `/workspace` now.")).toBe("It lives in now.");
  });

  it("still handles an unquoted path", () => {
    expect(applyProseRewrites("Manifest at /workspace/auditor_manifest_sha256.json is current.")).toBe(
      "Manifest at `auditor_manifest_sha256.json` is current.",
    );
  });

  it("leaves a path inside a code fence alone", () => {
    const body = "Run it like this:\n```\ncd /workspace/backend && node server.js\n```";
    const r = checkReplyBody(body);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bodyMd).toContain("/workspace/backend");
  });
});

describe("the rewrites leave a grammatical sentence", () => {
  it("closes up 'running on :3000: GET /bridge/status' (tcom_vy1slnuybh7n8s547ml2)", () => {
    const out = applyProseRewrites("The bridge is integrated into server.js and running on :3000: GET /bridge/status → 200");
    expect(out).not.toMatch(/running on:/);
    expect(out).toBe("The bridge is integrated into server.js and running: GET /bridge/status → 200");
  });

  it("closes up 'restarted on :3000 (node server.js)' (m_0yxvc4huvl9x08otglsf)", () => {
    expect(applyProseRewrites("Backend restarted on :3000 (node server.js).")).toBe(
      "Backend restarted (node server.js).",
    );
  });

  it("closes up 'live on :8080, GET' (m_xsn4ripuo0dbbk1kriil)", () => {
    expect(applyProseRewrites("Stream infrastructure is live on :8080, HLS manifest advancing.")).toBe(
      "Stream infrastructure is live, HLS manifest advancing.",
    );
  });

  it("does not double the rewritten vocabulary (tcom_dt99ueu5a2ghjrlwa49k)", () => {
    // "Automated auto-verifier returns…" became "Automated automated check
    // returns…" once the vocabulary table fired next to the author's own word.
    expect(applyProseRewrites("Automated auto-verifier returns verification_failed.")).toBe(
      "Automated check returns verification_failed.",
    );
  });

  it("leaves a trailing preposition alone when nothing was rewritten", () => {
    // The grammar repair only runs on a chunk we actually cut something out
    // of, so ordinary prose is never touched.
    expect(applyProseRewrites("I turned it on.")).toBe("I turned it on.");
    expect(applyProseRewrites("Nothing to report on.")).toBe("Nothing to report on.");
  });
});

describe("chat-template role tags", () => {
  for (const tag of ["</assistant>", "</body>", "<|im_end|>", "<|eot_id|>", "</s>"]) {
    it(`strips ${tag}`, () => {
      const out = sanitizeAgentProse(`Both artifacts are attached to their cards.\n\n${tag}`);
      expect(out.text).toBe("Both artifacts are attached to their cards.");
    });
  }

  it("rejects a body that is only a role tag (tcom_tb8jn3ujxgvb1yk6gn8q)", () => {
    expect(checkReplyBody("</assistant>").ok).toBe(false);
  });

  it("keeps a closing tag inside a code fence", () => {
    const body = "The page skeleton is:\n```html\n<body>\n<p>hi</p>\n</body>\n```\nLet me know if the layout works.";
    const r = checkReplyBody(body);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bodyMd).toContain("</body>");
  });
});

describe("ids, env vars, raw JSON and diffs", () => {
  it("drops an artifact id that points at no page", () => {
    expect(applyProseRewrites("Uploaded as art_9kd82hfks01x for review.")).toBe(
      "Uploaded as the attached file for review.",
    );
  });

  it("drops a raw message id", () => {
    expect(applyProseRewrites("As noted in m_nor3sbpdu5cgr4mfogmy the endpoint is up.")).toBe(
      "As noted in an earlier message the endpoint is up.",
    );
  });

  it("keeps a task id, which the client renders as a titled chip", () => {
    // task_/ap_/goal_ ids resolve to something a reader can open, so they are
    // chipped client-side rather than dropped here.
    expect(applyProseRewrites("Blocked on task_ru269ynq2atltqwlor8x.")).toContain("task_ru269ynq2atltqwlor8x");
  });

  it("removes an environment-variable assignment", () => {
    expect(applyProseRewrites("Reproduce with VERIFY_FAIL_MODE=hold set.").replace(/\s+/g, " ").trim()).toBe(
      "Reproduce with set.",
    );
  });

  it("rejects the verifier's raw JSON verdict (tcom_aeoc5c8fsobar7dkcuyj)", () => {
    const body =
      '{"verdict": "pass", "score": 1, "rationale": "Visitor summary verified live: qanda_visitor_summary.md (2,093B) served at HTTP 200 from backend."}';
    const r = checkReplyBody(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("verifier_json_leak");
  });

  it("rejects a bare unfenced JSON body", () => {
    const r = checkReplyBody('{"allowed_roles": ["Engineer", "Researcher & Writer"], "rate_limits": {"per_hour": 20}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("pure_json_dump");
  });

  it("rejects a one-line diff with no prose (m_th0r1ylnvuzqua6indjg)", () => {
    const r = checkReplyBody("+placeholder — comment body lives in the actions block");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("code_diff_leak");
  });

  it("rejects a two-line markdown diff (m_0yxvc4huvl9x08otglsf)", () => {
    const r = checkReplyBody("+## 2026-09-10 · @iris\n+Backend restarted. Re-verified the endpoint matrix — all 8 at HTTP 200.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("code_diff_leak");
  });

  it("still allows prose that merely contains a + line", () => {
    expect(checkReplyBody("Reached the vendor:\n+353 1 234 5678\nThey'll confirm pricing tomorrow.").ok).toBe(true);
  });
});

describe("junk floor for agent posts", () => {
  it("rejects a sub-15-character comment with no attachment", () => {
    const r = checkReplyBody("test comment", { hasAttachments: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_short");
  });

  it("allows a short body when a file actually came with it", () => {
    expect(checkReplyBody("source attached", { hasAttachments: true }).ok).toBe(true);
  });

  it("rejects a single-emoji message", () => {
    for (const body of ["👏", "✅", "👍", "👍👍"]) {
      const r = checkReplyBody(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(["emoji_only", "too_short"]).toContain(r.reason);
    }
  });

  it("allows an emoji alongside real words", () => {
    expect(checkReplyBody("✅ The migration finished — 12k rows moved, no errors.").ok).toBe(true);
  });

  it("has a usable hint for every new reason", () => {
    for (const reason of [
      "tool_output_transcript",
      "background_task_notice",
      "subagent_notice",
      "chat_template_tag",
      "verifier_json_leak",
      "emoji_only",
      "too_short",
    ]) {
      expect(guardRejectHint(reason).length).toBeGreaterThan(20);
    }
  });

  it("never tells an agent to set an environment variable", () => {
    for (const reason of ["verifier_json_leak", "too_short", "chat_template_tag"]) {
      expect(guardRejectHint(reason)).not.toMatch(/[A-Z][A-Z0-9_]{3,}=/);
    }
  });
});

describe("the verification-hold comment", () => {
  it("is recognisable as a system notice", () => {
    expect(isSystemNotice(`${VERIFICATION_HOLD_PREFIX} — the automated check is unavailable.`)).toBe(true);
    expect(isSystemNotice("Shipped the dashboard — ready for review.")).toBe(false);
  });
});
