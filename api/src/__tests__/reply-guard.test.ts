import { describe, it, expect } from "vitest";
import { checkReplyBody, guardRejectHint } from "../agents/reply-guard.js";

// The reply guard is the last line between agent runtime noise and a human's
// chat. These cases are distilled from real leaks observed in production
// channels — each rejection reason here once shipped as a garbage message.

describe("checkReplyBody accepts real replies", () => {
  it("plain prose", () => {
    const r = checkReplyBody("I've finished the research and posted a summary on the task.");
    expect(r.ok).toBe(true);
  });

  it("prose with a short inline code fence", () => {
    const r = checkReplyBody(
      "To reproduce, run:\n```\nnpm run build\n```\nand check the output directory.",
    );
    expect(r.ok).toBe(true);
  });

  it("deploy claim WITH a proving URL", () => {
    const r = checkReplyBody("Deployed the new landing page — it's live at https://example.com/launch.");
    expect(r.ok).toBe(true);
  });
});

describe("checkReplyBody rejects runtime leaks", () => {
  const cases: Array<{ name: string; body: string; reason: string }> = [
    { name: "empty body", body: "   \n  ", reason: "empty_body" },
    { name: "heartbeat sentinel", body: "HEARTBEAT_OK", reason: "heartbeat_leaked" },
    {
      name: "bare action JSON",
      body: '{"type":"share_to_task","task_id":"task_abc","files":[{"path":"/workspace/x"}]}',
      reason: "action_json_leaked",
    },
    {
      name: "tool-call-as-prose syntax",
      body: "update_task(task_id=task_123, status=done)",
      reason: "tool_call_syntax",
    },
    {
      // A malformed block that still carries action JSON trips the (earlier)
      // bare-JSON check; the tag check below catches tag-only leftovers.
      name: "malformed <actions> block with action JSON inside",
      body: 'Done! <actions>[{"type":"task_comment", "task_id": "task_1"',
      reason: "action_json_leaked",
    },
    {
      name: "truncated <actions> tag with no parsable JSON",
      body: "Done for today! <actions>\n[\n",
      reason: "actions_block_visible",
    },
    {
      name: "deploy claim with no URL",
      body: "The deployment is now complete.",
      reason: "deploy_claim_no_url",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const r = checkReplyBody(c.body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(c.reason);
    });
  }

  it("attachment claim with no attachment", () => {
    const r = checkReplyBody("I've attached the final report for review.", {
      hasAttachments: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("attachment_claim_no_file");
  });

  it("same attachment claim passes when files are present", () => {
    const r = checkReplyBody("I've attached the final report for review.", {
      hasAttachments: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe("guardRejectHint", () => {
  it("returns actionable guidance for taught reasons", () => {
    expect(guardRejectHint("deploy_claim_no_url")).toContain("BLOCKED");
    expect(guardRejectHint("credential_beg")).toContain("request_approval");
  });

  it("returns empty string for self-explanatory reasons", () => {
    expect(guardRejectHint("empty_body")).toBe("");
  });
});

describe("checkReplyBody — leak classes observed in production", () => {
  const reject: Array<{ name: string; body: string; reason: string }> = [
    // HEARTBEAT_OK must be caught ANYWHERE, not just at the start.
    { name: "heartbeat bolded mid-reply", body: "**HEARTBEAT_OK** — I've scoped the lists.", reason: "heartbeat_leaked" },
    { name: "heartbeat trailing a warning", body: "Warning: Unknown toolsets: mcp-circlechat\nHEARTBEAT_OK", reason: "heartbeat_leaked" },
    // Runtime "no reply / empty content" diagnostics leaking as a message.
    { name: "empty-reply notice", body: "⚠️ No reply: the model returned empty content after retries and any fallback providers. Try `continue`, switch model/provider.", reason: "empty_reply_notice" },
    // New CoT/planning forms.
    { name: "cot: we need to answer", body: "We need to answer the latest user message after summary.", reason: "cot_leak" },
    { name: "cot: looking at my tasks and the board", body: "Looking at my tasks and the board, I can see that task_x is open.", reason: "cot_leak" },
    { name: "cot: context compaction marker", body: "[CONTEXT COMPACTION — REF] the latest user message is…", reason: "cot_leak" },
    // Degenerate multi-script garbage.
    { name: "garbled multi-script soup", body: "Report exactery ジ Comm Blvd 街道 Zahy సి BHP Streets 农业农村部 done now ok thanks", reason: "garbled_output" },
  ];
  for (const c of reject) {
    it(`rejects ${c.name}`, () => {
      const r = checkReplyBody(c.body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(c.reason);
    });
  }

  const pass: Array<{ name: string; body: string }> = [
    { name: "normal reply", body: "Thanks — I'll review the scroll animations and report back." },
    { name: "one foreign name is not garbage", body: "Met with 王 about the Q3 deal; all good." },
    { name: "legit mention of heartbeat-like word", body: "The heartbeat monitor is green and the deploy looks healthy." },
  ];
  for (const c of pass) {
    it(`allows ${c.name}`, () => {
      expect(checkReplyBody(c.body).ok).toBe(true);
    });
  }

  it("hints exist for the new reasons", () => {
    expect(guardRejectHint("garbled_output")).toContain("garbled");
    expect(guardRejectHint("empty_reply_notice")).toContain("HEARTBEAT_OK");
  });
});
