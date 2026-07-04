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
    // The trigger word itself, echoed without the _OK suffix (samantha posted
    // exactly this into #neu-site twice, 2026-06-27 and 2026-07-03).
    { name: "bare HEARTBEAT as the whole reply", body: "HEARTBEAT", reason: "heartbeat_leaked" },
    { name: "bare HEARTBEAT mid-prose", body: "Trigger was HEARTBEAT — nothing to report.", reason: "heartbeat_leaked" },
    // Plain-prose diff hunk: `+`-glued lines that are neither code nor markdown
    // shaped, so the code/md diff counters both missed it (phil in #general,
    // 2026-07-01, complete with an unexpanded $(date -u)).
    {
      name: "plain-text + diff dump",
      body: "+Neu Site Verification\n+====================\n+\n+Timestamp: $(date -u)\n+\n+URL: https://example.com/\n+\n+Console log: initialized successfully!\n+\n+No JavaScript errors detected.\n+\n+Site is live and operational.",
      reason: "code_diff_leak",
    },
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
    // Sparse +/- lines in normal prose must not read as a diff dump.
    { name: "a +1 ack", body: "+1" },
    { name: "phone number line", body: "Reached the vendor:\n+353 1 234 5678\nThey'll confirm pricing tomorrow." },
    {
      name: "prose with --- separators",
      body: "Summary of the audit.\n---\nFindings: two broken links.\n---\nNext: fix and re-verify.\n---\nOwner: me.",
    },
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

describe("checkReplyBody — tool-narration replies", () => {
  // Verbatim tool-output narration that filled the live #general fishbowl:
  // the model described what a browser/DOM tool returned, or narrated its own
  // plan in the third person, instead of replying.
  const reject: Array<{ name: string; body: string }> = [
    { name: "title-of-webpage narration", body: 'The title of the webpage is "Example Domain".' },
    { name: "browser snapshot narration", body: "The browser snapshot shows an empty page with no interactive elements." },
    {
      name: "user's-goal + tool-function narration",
      body: "The user's goal is to extract the content of the webpage at the given URL. The browser_navigate function was used to load it.",
    },
    { name: "browser console narration", body: "The browser console output is empty, with no messages or JavaScript errors." },
    { name: "page-heading narration", body: 'The page has a heading "Example Domains" and a paragraph of body copy.' },
    { name: "based-on-user's-response narration", body: "Based on the user's response, I will proceed with the assumption that the copy is approved." },
    { name: "bare browser_ function name", body: "browser_click(selector=\"#submit\") returned no error." },
  ];
  for (const c of reject) {
    it(`rejects ${c.name}`, () => {
      const r = checkReplyBody(c.body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("tool_narration");
    });
  }

  // Legitimate first-person work updates must pass — these were the exact
  // examples flagged as false-positive risks.
  const pass: Array<{ name: string; body: string }> = [
    { name: "sharing a brief", body: "Sharing showcase brief for review." },
    { name: "created + attached a file", body: "I've created a simple HTML file for the showcase page and attached it to the task." },
    { name: "browser compatibility is not narration", body: "The browser compatibility looks fine across Chrome and Safari." },
    { name: "prose about a page title", body: "The title of the page needs updating — I'll shorten it." },
  ];
  for (const c of pass) {
    it(`allows ${c.name}`, () => {
      expect(checkReplyBody(c.body).ok).toBe(true);
    });
  }

  it("has a teaching hint", () => {
    expect(guardRejectHint("tool_narration")).toContain("first-person");
  });
});

describe("checkReplyBody — provider/gateway error echoes on the reply path", () => {
  const reject: Array<{ name: string; body: string }> = [
    // The exact string that leaked verbatim as an agent reply (len=109).
    {
      name: "HTTP 400 all-routed-providers (live leak)",
      body: "HTTP 400: All routed providers rejected the request as invalid. Last error: Cohere API error 400: Bad Request",
    },
    { name: "bare HTTP status line", body: "HTTP 502: Bad Gateway" },
    { name: "provider API error at start", body: "OpenAI API error 429: rate limit exceeded" },
  ];
  for (const c of reject) {
    it(`rejects ${c.name}`, () => {
      const r = checkReplyBody(c.body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("provider_error_echo");
    });
  }

  const pass: Array<{ name: string; body: string }> = [
    { name: "discussing an HTTP error mid-sentence", body: "I hit an HTTP 500 on deploy, retrying with a smaller payload now." },
    { name: "mentioning an API error in prose", body: "Heads up: the vendor returned an API error 503 earlier, but it recovered." },
  ];
  for (const c of pass) {
    it(`allows ${c.name}`, () => {
      expect(checkReplyBody(c.body).ok).toBe(true);
    });
  }

  it("has a teaching hint", () => {
    expect(guardRejectHint("provider_error_echo")).toContain("HEARTBEAT_OK");
  });
});
