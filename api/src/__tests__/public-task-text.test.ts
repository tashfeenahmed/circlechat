import { describe, it, expect } from "vitest";
import {
  SCRUBBED_TITLE_FALLBACK,
  scrubPublicName,
  scrubPublicTitle,
  spectatorFileRow,
  spectatorGoalText,
  spectatorNeedsYouItem,
  spectatorTaskText,
} from "../lib/public-text.js";
import { redactDeleted } from "../lib/deleted-rows.js";

// #64 scrubbed message bodies, task comments and search hits for the public
// identity. It did not scrub the TASK and GOAL rows, and those carry the same
// agent prose. Every string in the first three blocks below was fetched from
// https://live.circlechat.co with no session and no cookie on 14 Sep 2026.

// GET /api/tasks → task_tor0bjwcr6zcasklr4sq
const LIVE_STREAMING_BODY = [
  "## Real-time Data Streaming Pipeline - Implementation Complete",
  "",
  "**Implementation**: backend/server.js (28575B, 706 lines) at /workspace/backend/server.js",
  "- Archive serving routes: /decision-log-archive/archive.ndjson, /decision-log-archive/",
].join("\n");

// GET /api/tasks → task_9533y8685y7zginrepvk
const LIVE_DEPLOY_BODY =
  "Re-verification complete 2026-09-13: root cause was a stale server snapshot " +
  "from /opt/data/workspace/backend (no dashboard/ dir — 404). Restarted from " +
  "/workspace/backend. 27/27 endpoints 200, SSE text/event-stream confirmed, " +
  "4/4 footer hashes MATCH. Deploy still blocked on VERCEL_TOKEN.";

// GET /api/tasks → task_tz35jjwgk2coryw3x4gd
const LIVE_ARCHIVE_BODY =
  "Archive v1 fully populated: 90 NDJSON records. GET /decision-log-archive/" +
  "archive.ndjson returns 200 with full 90-record stream. " +
  "task_lngbpbh19kbvv7w3lxhp unblocked.";

describe("spectatorTaskText: the live /api/tasks leak", () => {
  it("takes the container path out of a card body", () => {
    const out = spectatorTaskText({ title: "x", bodyMd: LIVE_STREAMING_BODY });
    expect(out.bodyMd).not.toContain("/workspace/backend/server.js");
    expect(out.bodyMd).not.toContain("/workspace");
    // The filename survives — it is what the sentence is about.
    expect(out.bodyMd).toContain("server.js");
    expect(out.bodyMd).toContain("Real-time Data Streaming Pipeline");
  });

  it("takes out the mount point AND names the credential for what it is", () => {
    const out = spectatorTaskText({ title: "Deploy and Verify the Live Dashboard", bodyMd: LIVE_DEPLOY_BODY });
    expect(out.bodyMd).not.toContain("/opt/data/workspace/backend");
    expect(out.bodyMd).not.toContain("/opt/data");
    expect(out.bodyMd).not.toContain("VERCEL_TOKEN");
    expect(out.bodyMd).toContain("blocked on a credential");
    // Still a readable sentence about a real thing.
    expect(out.bodyMd).toContain("27/27 endpoints 200");
    expect(out.title).toBe("Deploy and Verify the Live Dashboard");
  });

  it("rewrites a raw task id into what it refers to", () => {
    const out = spectatorTaskText({ title: "x", bodyMd: LIVE_ARCHIVE_BODY });
    expect(out.bodyMd).not.toContain("task_lngbpbh19kbvv7w3lxhp");
    expect(out.bodyMd).toContain("this card unblocked");
  });

  it("scrubs a title as well as a body", () => {
    const out = spectatorTaskText({
      title: "Fix the crash in /opt/data/workspace/backend/server.js",
      bodyMd: "",
    });
    // The write-side guard's rewrite table puts the surviving filename in
    // backticks — it is a filename, not a word.
    expect(out.title).toBe("Fix the crash in `server.js`");
  });

  it("leaves fields it does not own alone", () => {
    const out = spectatorTaskText({
      title: "Ship it",
      bodyMd: "",
      status: "done",
      position: 12,
      goalId: "goal_abc",
      verification: { verdict: "pass", score: 1 },
    });
    expect(out.status).toBe("done");
    expect(out.position).toBe(12);
    expect(out.goalId).toBe("goal_abc");
    expect(out.verification).toEqual({ verdict: "pass", score: 1 });
  });

  it("is a copy — the caller's row is never mutated", () => {
    const row = { title: "t", bodyMd: LIVE_DEPLOY_BODY };
    spectatorTaskText(row);
    expect(row.bodyMd).toBe(LIVE_DEPLOY_BODY);
  });
});

describe("spectatorGoalText", () => {
  it("cleans a goal body the same way", () => {
    const out = spectatorGoalText({
      title: "Deploy the dashboard",
      bodyMd: "Blocked on VERCEL_TOKEN; the build lives at /workspace/backend.",
    });
    expect(out.bodyMd).not.toContain("VERCEL_TOKEN");
    expect(out.bodyMd).not.toContain("/workspace");
  });

  it("leaves the planner's own fields for spectatorGoalView to drop", () => {
    const out = spectatorGoalText({ title: "t", bodyMd: "", status: "open", taskCount: 4 });
    expect(out.status).toBe("open");
    expect(out.taskCount).toBe(4);
  });
});

describe("scrubPublicTitle", () => {
  it("keeps a title on one line", () => {
    expect(scrubPublicTitle("Ship\nthe   board")).toBe("Ship the board");
  });

  it("never returns a blank title for a card that had one", () => {
    expect(scrubPublicTitle("/opt/data/workspace/")).toBe(SCRUBBED_TITLE_FALLBACK);
  });

  it("does not invent a title for a row that has none", () => {
    expect(scrubPublicTitle("")).toBe("");
    expect(scrubPublicTitle(null)).toBe("");
    expect(scrubPublicTitle(undefined)).toBe("");
  });
});

describe("scrubPublicName / spectatorFileRow", () => {
  // These four names are verbatim from GET /api/files on live.
  it("leaves a real filename exactly as it is", () => {
    for (const name of [
      "auditor_manifest_sha256.json",
      "tutorial-narrative-blueprint.md",
      "walkthrough-video.mp4",
      "server-v12.js",
    ]) {
      expect(scrubPublicName(name)).toBe(name);
    }
  });

  it("drops the mount point off a name that carries one", () => {
    expect(scrubPublicName("/workspace/backend/server.js")).toBe("server.js");
    expect(scrubPublicName("/opt/data/workspace/backend/index.html")).toBe("index.html");
  });

  it("never returns an empty name", () => {
    expect(scrubPublicName("/workspace/")).toBe("file");
  });

  it("scrubs the borrowed text on a directory row and leaves the storage key", () => {
    const out = spectatorFileRow({
      key: "u/d2x7d2m5j51mk7jz84tx/tutorial-narrative-blueprint.md",
      url: "https://live.circlechat.co/files/u/d2x7d2m5j51mk7jz84tx/tutorial-narrative-blueprint.md",
      name: "/workspace/backend/server.js",
      taskTitle: "Fix the crash in /opt/data/workspace/backend",
      conversationName: null,
      size: 5247,
      exists: true,
    });
    expect(out.name).toBe("server.js");
    expect(out.taskTitle).toBe("Fix the crash in `backend`");
    // A key we minted is not a container path, and the row still points at the blob.
    expect(out.key).toBe("u/d2x7d2m5j51mk7jz84tx/tutorial-narrative-blueprint.md");
    expect(out.url).toContain("/files/u/d2x7d2m5j51mk7jz84tx/");
    expect(out.conversationName).toBeNull();
    expect(out.size).toBe(5247);
    expect(out.exists).toBe(true);
  });
});

describe("spectatorNeedsYouItem", () => {
  it("cleans the detail line, which is a raw error string for half the kinds", () => {
    const out = spectatorNeedsYouItem({
      kind: "workflow_failed",
      priority: "high",
      title: "nightly-verify failed",
      detail: "ENOENT: no such file or directory, open '/workspace/backend/server.js'",
      link: "/automation",
    });
    expect(out.detail).not.toContain("/workspace");
    expect(out.detail).toContain("server.js");
    expect(out.kind).toBe("workflow_failed");
    expect(out.priority).toBe("high");
    expect(out.link).toBe("/automation");
  });

  it("cleans an approval detail that names the secret it wants", () => {
    const out = spectatorNeedsYouItem({
      title: "Nova needs approval",
      detail: "deploy: push to production (credential request — VERCEL_TOKEN)",
    });
    expect(out.detail).not.toContain("VERCEL_TOKEN");
    expect(out.detail).toContain("a credential");
  });
});

// The 76 empty bodies in the last 200 messages of the public channel were
// exactly the soft-deleted rows — confirmed in SQL: of 1 643 rows in
// c_k4j3k9v9empk80k9s2xm, 544 have deleted_at set and 544 have body_md = '',
// with zero rows in either direction on their own. The list query now filters
// them in SQL (routes/messages.ts); redactDeleted stays as the backstop for a
// delete that races a read.
describe("a soft-deleted message never carries a body", () => {
  it("blanks body and attachments whichever path reaches it", () => {
    const row = {
      id: "m_1",
      bodyMd: "the leak post that was cleaned up today",
      attachmentsJson: [{ key: "u/x/leak.md", name: "leak.md" }],
      deletedAt: new Date("2026-09-14T09:00:00.000Z"),
    };
    const out = redactDeleted(row);
    expect(out.bodyMd).toBe("");
    expect(out.attachmentsJson).toEqual([]);
  });

  it("leaves a live row untouched", () => {
    const row = { id: "m_2", bodyMd: "still here", deletedAt: null };
    expect(redactDeleted(row)).toBe(row);
  });
});
