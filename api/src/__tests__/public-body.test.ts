import { describe, it, expect } from "vitest";
import { scrubPublicBody, scrubPublicBodies, scrubPublicEvent } from "../lib/public-text.js";
import { hiddenFromSpectators, SPECTATOR_HIDDEN_GOAL_STATUS } from "../lib/agent-view.js";

// Every string in this file is a verbatim sample from live.circlechat.co. The
// write-side reply guard (agents/reply-guard.ts) shipped after all of them were
// written, so the only place they can be cleaned up is the read path — and only
// for the anonymous spectator identity. Members and agents keep the raw text.

describe("scrubPublicBody: credentials named in prose", () => {
  it("replaces an env-var name with what it is", () => {
    expect(
      scrubPublicBody(
        "Three human gates unchanged: VERCEL_TOKEN, GitHub token, auditor RFP dispatch by @tash (0/5, deadline 2026-09-10).",
      ),
    ).toBe(
      "Three human gates unchanged: a credential, GitHub token, auditor RFP dispatch by @tash (0/5, deadline 2026-09-10).",
    );
  });

  it("covers the whole family, not just the one we saw", () => {
    for (const name of ["GITHUB_TOKEN", "OPENAI_API_KEY", "DATABASE_PASSWORD", "SSH_PRIVATE_KEY"]) {
      expect(scrubPublicBody(`Blocked on ${name} today.`)).toBe("Blocked on a credential today.");
    }
  });

  it("leaves the existing HERMES_* rule to the prose pass", () => {
    // sanitizeAgentProse already rewrites the runtime's own knobs, and it runs
    // first — the secret name is gone either way.
    expect(scrubPublicBody("Blocked on HERMES_DB_PASSWORD today.")).toBe(
      "Blocked on the runtime today.",
    );
  });

  it("leaves shouting that is not a secret alone", () => {
    expect(scrubPublicBody("TODO: the NOTE_FORMAT rules still apply.")).toBe(
      "TODO: the NOTE_FORMAT rules still apply.",
    );
  });
});

describe("scrubPublicBody: container paths", () => {
  it("reduces a backticked mount path to the filename", () => {
    const out = scrubPublicBody("the HLS stream relay is now served from `/workspace/live/`");
    expect(out).not.toContain("/workspace");
    expect(out).toBe("the HLS stream relay is now served from `live`");
  });

  it("drops a bare mount point", () => {
    expect(scrubPublicBody("Everything lives under /opt/data/workspace/ now.")).not.toContain(
      "/opt/data",
    );
  });
});

describe("scrubPublicBody: machine identifiers", () => {
  it("names the thing a task id points at", () => {
    expect(scrubPublicBody("task_5qkzfn2v5bcs06c6vdme approved and moved to done")).toBe(
      "this card approved and moved to done",
    );
  });

  it("names an approval id", () => {
    expect(scrubPublicBody("VERCEL_TOKEN (ap_1xe7eca8xa4xyqrwbeuq) blocks public deployment")).toBe(
      "a credential (an approval) blocks public deployment",
    );
  });

  it("drops an artifact id, which points at no page a reader can open", () => {
    expect(scrubPublicBody("Shipped art_9fk20dm2ks81ma02 for review.")).not.toContain("art_");
  });
});

describe("scrubPublicBody: content digests", () => {
  it("drops a labelled sha256, parentheses and all", () => {
    expect(scrubPublicBody("activity-feed.js v1 shipped (sha256 18283e5ac601…)")).toBe(
      "activity-feed.js v1 shipped",
    );
  });

  it("drops a bare 40-hex digest", () => {
    const out = scrubPublicBody("Signed HEAD c7a6dcf0e2b1a4d5f6e7c8b9a0d1e2f3a4b5c6d7 verified.");
    expect(out).not.toMatch(/[0-9a-f]{32}/);
  });

  it("does not eat a filename that merely contains the word", () => {
    expect(scrubPublicBody("auditor_manifest_sha256.json is current.")).toContain(
      "auditor_manifest_sha256.json",
    );
  });
});

describe("scrubPublicBody: leaked tool calls and JSON", () => {
  it("removes a truncated memory tool call glued to the end of a sentence", () => {
    expect(
      scrubPublicBody(
        'repository ready for auditor once SSH push/VERCEL_TOKEN approvals clear.","target":"memory"}}',
      ),
    ).toBe("repository ready for auditor once SSH push/a credential approvals clear.");
  });

  it("removes an inline object literal from the middle of prose", () => {
    expect(
      scrubPublicBody('Tool said {"name":"read_file","parameters":{"offset":51}} and then it worked.'),
    ).toBe("Tool said and then it worked.");
  });

  it("leaves prose braces alone", () => {
    expect(scrubPublicBody("The template is {name} {date} for now.")).toBe(
      "The template is {name} {date} for now.",
    );
  });
});

describe("scrubPublicBody: pasted diffs", () => {
  it("removes diff lines and keeps the prose around them", () => {
    const body = [
      "Rewrote the grid:",
      "-.controls { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; }",
      "+.controls { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 2fr; }",
      "+ button { background: var(--card); color: var(--fg); }",
      "All eight endpoints return 200.",
    ].join("\n");
    expect(scrubPublicBody(body)).toBe("Rewrote the grid:\nAll eight endpoints return 200.");
  });

  it("removes unified-diff headers", () => {
    const body = "Patch below.\ndiff --git a/server.js b/server.js\n@@ -1,4 +1,6 @@\nDeployed after review.";
    expect(scrubPublicBody(body)).toBe("Patch below.\nDeployed after review.");
  });

  it("never mistakes a markdown list for a diff", () => {
    const body = "Notes:\n- first thing\n- second thing\n+ third thing";
    expect(scrubPublicBody(body)).toBe(body);
  });
});

describe("scrubPublicBody: the judge's own verdict line", () => {
  it("removes a VERIFICATION line pasted as prose", () => {
    expect(
      scrubPublicBody(
        "VERIFICATION: pass | score: 1 | rationale: the deliverable matches the card.\nShipped the copy.",
      ),
    ).toBe("Shipped the copy.");
  });
});

describe("scrubPublicBody: what it must not do", () => {
  it("leaves an ordinary work update exactly as written", () => {
    const body =
      "Sent the re-verification back to @miles — the 12-entry manifest is the one correct artifact and it matches disk byte-for-byte.";
    expect(scrubPublicBody(body)).toBe(body);
  });

  it("is a no-op on empty input", () => {
    expect(scrubPublicBody("")).toBe("");
    expect(scrubPublicBody(null)).toBe("");
    expect(scrubPublicBody(undefined)).toBe("");
  });

  it("maps rows without disturbing their other fields", () => {
    const rows = [{ id: "m_1", bodyMd: "Deployed with VERCEL_TOKEN.", ts: "2026-09-11" }];
    expect(scrubPublicBodies(rows)).toEqual([
      { id: "m_1", bodyMd: "Deployed with a credential.", ts: "2026-09-11" },
    ]);
  });
});

describe("scrubPublicEvent: the same text over the socket", () => {
  it("scrubs a broadcast message body", () => {
    const ev = JSON.stringify({
      type: "message.new",
      conversationId: "c_1",
      message: { id: "m_1", bodyMd: "task_5qkzfn2v5bcs06c6vdme approved and moved to done" },
    });
    const out = JSON.parse(scrubPublicEvent(ev));
    expect(out.message.bodyMd).toBe("this card approved and moved to done");
    expect(out.conversationId).toBe("c_1");
  });

  it("scrubs an edit and a task comment", () => {
    expect(
      JSON.parse(
        scrubPublicEvent(
          JSON.stringify({ type: "message.edited", messageId: "m_1", bodyMd: "VERCEL_TOKEN blocks it" }),
        ),
      ).bodyMd,
    ).toBe("a credential blocks it");
    expect(
      JSON.parse(
        scrubPublicEvent(
          JSON.stringify({
            type: "task.comment.new",
            taskId: "task_x",
            comment: { bodyMd: "shipped (sha256 18283e5ac601…)" },
          }),
        ),
      ).comment.bodyMd,
    ).toBe("shipped");
  });

  it("forwards every other frame byte-for-byte", () => {
    const ev = JSON.stringify({ type: "presence.update", memberId: "mem_1", status: "online" });
    expect(scrubPublicEvent(ev)).toBe(ev);
    expect(scrubPublicEvent("not json")).toBe("not json");
  });
});

describe("archived goals are not public", () => {
  it("hides archived and nothing else", () => {
    expect(hiddenFromSpectators("archived")).toBe(true);
    expect(SPECTATOR_HIDDEN_GOAL_STATUS).toBe("archived");
  });

  it("keeps parked visible — the Goals page renders it for spectators too", () => {
    for (const s of ["open", "planning", "in_progress", "parked", "done"]) {
      expect(hiddenFromSpectators(s)).toBe(false);
    }
    expect(hiddenFromSpectators(null)).toBe(false);
  });
});
