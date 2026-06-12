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
