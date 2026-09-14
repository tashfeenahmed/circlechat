import { describe, it, expect } from "vitest";
import {
  collapseVersions,
  deliverableSetKey,
  expectedKinds,
  isAncillaryName,
  looksLikePaperworkText,
  paperworkAskedFor,
  scoreDeliverables,
  selectDeliverables,
  MIN_PRIMARY_BYTES,
  type DeliverableCandidate,
} from "../lib/deliverable-select.js";
import { renderDeliverableSet, renderPaperworkNotice, PAPERWORK_PROMPT_LINE } from "../lib/task-verifier.js";
import { isShrinkingReplacement } from "../lib/task-artifacts.js";

// Which artifact IS the deliverable? The verifier used to take the last one
// attached, so an agent that shipped dashboard.html and then attached its own
// verification write-up got failed with "this is a UX research document, not an
// interactive dashboard" (live: task_qqfu1z2w5p2nj2ntw7gs).

let seq = 0;
function art(over: Partial<DeliverableCandidate> & { name: string }): DeliverableCandidate {
  seq++;
  return {
    id: `art_${String(seq).padStart(4, "0")}`,
    contentType: "text/plain",
    size: 5000,
    version: 1,
    createdAt: new Date(Date.UTC(2026, 8, 13, 12, 0, seq)),
    ...over,
  };
}

describe("expectedKinds", () => {
  it("reads the deliverable kind off the TITLE", () => {
    expect(expectedKinds("Build an interactive governance dashboard", "")).toContain("web");
    expect(expectedKinds("Write a market research report", "")).toContain("doc");
    expect(expectedKinds("Write a CLI script to sync the feeds", "")).toContain("code");
  });

  it("ignores incidental body vocabulary when the title is decisive", () => {
    // The body mentions "report" and "review", but the ask is a dashboard —
    // letting the body vote is exactly what made every .md look requested.
    const kinds = expectedKinds(
      "Build an interactive governance dashboard",
      "Report on the governance feeds and review the data sources before you start.",
    );
    expect(kinds).toEqual(["web"]);
  });

  it("falls back to the body when the title says nothing", () => {
    expect(expectedKinds("Follow-up for Q3", "Deliver a spreadsheet of the export")).toContain("data");
  });
});

describe("isAncillaryName", () => {
  const nothingAsked = new Set<string>();

  it("flags paperwork about the work", () => {
    expect(isAncillaryName("audit-governance-feeds-2026-09-13.md", nothingAsked)).toBe(true);
    expect(isAncillaryName("dashboard-ux-research.md", nothingAsked)).toBe(true);
    expect(isAncillaryName("verify-dashboard-2026-09-13.md", nothingAsked)).toBe(true);
    expect(isAncillaryName("backend-full-verification-2026-09-13.md", nothingAsked)).toBe(true);
    expect(isAncillaryName("SHA256SUMS", nothingAsked)).toBe(true);
  });

  it("does not flag the work itself", () => {
    expect(isAncillaryName("dashboard.html", nothingAsked)).toBe(false);
    expect(isAncillaryName("tutorial-workspace-prototype.html", nothingAsked)).toBe(false);
    expect(isAncillaryName("sync-feeds.ts", nothingAsked)).toBe(false);
  });

  it("forgives a token the BRIEF itself asked for", () => {
    // "Write the Q3 audit report" makes audit-report.md the deliverable.
    const asked = new Set(["write", "q3", "audit", "report"]);
    expect(isAncillaryName("q3-audit-report.md", asked)).toBe(false);
  });
});

describe("collapseVersions", () => {
  it("skips a tiny newer version when a larger one of the same name exists", () => {
    // The live shape: dashboard.html v1=292 B, v3=189 B, v2/4/5/6=13,915 B.
    const rows = [
      art({ name: "dashboard.html", version: 1, size: 292 }),
      art({ name: "dashboard.html", version: 2, size: 13915 }),
      art({ name: "dashboard.html", version: 3, size: 189 }),
      art({ name: "dashboard.html", version: 4, size: 13915 }),
    ];
    const [chosen] = collapseVersions(rows);
    expect(chosen.version).toBe(4);
    expect(chosen.size).toBe(13915);
  });

  it("would not be fooled if the tiny version were the newest", () => {
    const rows = [
      art({ name: "dashboard.html", version: 5, size: 13915 }),
      art({ name: "dashboard.html", version: 6, size: 189 }),
    ];
    const [chosen] = collapseVersions(rows);
    expect(chosen.version).toBe(5);
  });

  it("keeps the highest version when every version is small", () => {
    const rows = [
      art({ name: "note.txt", version: 1, size: 200 }),
      art({ name: "note.txt", version: 2, size: 300 }),
    ];
    expect(collapseVersions(rows)[0].version).toBe(2);
  });

  it("returns one row per distinct name", () => {
    const rows = [
      art({ name: "a.html", version: 1 }),
      art({ name: "a.html", version: 2 }),
      art({ name: "b.md", version: 1 }),
    ];
    expect(collapseVersions(rows).map((r) => r.name).sort()).toEqual(["a.html", "b.md"]);
  });
});

describe("selectDeliverables — the live regression", () => {
  const title = "Build an interactive governance dashboard";
  const body = "A single-page dashboard over the governance feed data, with filters and live updates.";

  it("judges dashboard.html, not the verification write-up attached after it", () => {
    const rows = [
      art({ name: "dashboard.html", contentType: "text/html", size: 13915, version: 6, createdAt: new Date("2026-09-13T21:45:00Z") }),
      art({ name: "audit-governance-feeds-2026-09-13.md", contentType: "text/markdown", size: 9000, createdAt: new Date("2026-09-13T22:28:00Z") }),
      art({ name: "dashboard-ux-research.md", contentType: "text/markdown", size: 11000, createdAt: new Date("2026-09-13T22:28:30Z") }),
    ];
    const sel = selectDeliverables(rows, title, body);
    expect(sel.primary?.name).toBe("dashboard.html");
    // Paperwork is dropped entirely when real work exists — the judge should
    // not be reading a UX-research doc to decide whether a dashboard was built.
    expect(sel.set.map((r) => r.name)).toEqual(["dashboard.html"]);
  });

  it("holds up on the second live card (prototype + three verification docs)", () => {
    const rows = [
      art({ name: "tutorial-workspace-prototype.html", contentType: "text/html", size: 21000, version: 4 }),
      art({ name: "dashboard.html", contentType: "text/html", size: 13915 }),
      art({ name: "audit-governance-feeds-2026-09-13.md", size: 9000 }),
      art({ name: "verify-dashboard-2026-09-13.md", size: 8000 }),
      art({ name: "backend-full-verification-2026-09-13.md", size: 12000 }),
    ];
    const sel = selectDeliverables(rows, "Build a tutorial workspace prototype", "An interactive prototype of the tutorial workspace.");
    expect(sel.primary?.name).toBe("tutorial-workspace-prototype.html");
    expect(sel.set).not.toContainEqual(expect.objectContaining({ name: "verify-dashboard-2026-09-13.md" }));
  });

  it("keeps several real deliverables together so the SET is judged", () => {
    const rows = [
      art({ name: "dashboard.html", contentType: "text/html", size: 13915 }),
      art({ name: "wireframes.html", contentType: "text/html", size: 7000 }),
      art({ name: "dashboard-ux-research.md", size: 11000 }),
    ];
    const sel = selectDeliverables(rows, title, body);
    expect(sel.set.map((r) => r.name)).toEqual(["dashboard.html", "wireframes.html"]);
  });

  it("still ranks the report first when the brief actually asked for a report", () => {
    const rows = [
      art({ name: "competitor-research-report.md", contentType: "text/markdown", size: 14000 }),
      art({ name: "raw-notes.md", size: 3000 }),
    ];
    const sel = selectDeliverables(rows, "Write a competitor research report", "Cover pricing and positioning.");
    expect(sel.primary?.name).toBe("competitor-research-report.md");
  });

  it("falls back to the full ranking when EVERYTHING looks like paperwork", () => {
    const rows = [art({ name: "notes.md", size: 4000 }), art({ name: "manifest.json", size: 500 })];
    const sel = selectDeliverables(rows, "Collect the feed inventory", "");
    expect(sel.primary).not.toBeNull();
    expect(sel.primary!.name).toBe("notes.md");
  });

  it("prefers a substantial file over a sub-1 KB one of a different name", () => {
    const rows = [
      art({ name: "stub.html", contentType: "text/html", size: 300 }),
      art({ name: "dashboard.html", contentType: "text/html", size: 13915 }),
    ];
    expect(selectDeliverables(rows, title, body).primary!.name).toBe("dashboard.html");
  });

  it("returns nothing when there is nothing to judge", () => {
    const sel = selectDeliverables([], title, body);
    expect(sel.primary).toBeNull();
    expect(sel.set).toEqual([]);
  });

  it("is deterministic — the same inputs always yield the same order", () => {
    const rows = [
      art({ name: "a.html", contentType: "text/html", size: 5000 }),
      art({ name: "b.html", contentType: "text/html", size: 5000 }),
    ];
    const first = selectDeliverables(rows, title, body).set.map((r) => r.id);
    const second = selectDeliverables([...rows].reverse(), title, body).set.map((r) => r.id);
    expect(first).toEqual(second);
  });
});

describe("scoreDeliverables", () => {
  it("explains why a file was demoted", () => {
    const ranked = scoreDeliverables(
      [
        art({ name: "dashboard.html", contentType: "text/html", size: 13915 }),
        art({ name: "verification-notes.md", size: 9000 }),
      ],
      "Build a dashboard",
      "",
    );
    const demoted = ranked.find((r) => r.row.name === "verification-notes.md")!;
    expect(demoted.ancillary).toBe(true);
    expect(demoted.reasons.join(" ")).toContain("paperwork");
    expect(ranked[0].row.name).toBe("dashboard.html");
  });
});

describe("deliverableSetKey", () => {
  it("is stable across ordering and changes when a version changes", () => {
    const a = art({ name: "dashboard.html", size: 13915, version: 6 });
    const b = art({ name: "wireframes.html", size: 7000, version: 1 });
    expect(deliverableSetKey([a, b])).toBe(deliverableSetKey([b, a]));
    expect(deliverableSetKey([{ ...a, version: 7 }, b])).not.toBe(deliverableSetKey([a, b]));
  });
});

describe("renderDeliverableSet", () => {
  it("labels a single file plainly", () => {
    const block = renderDeliverableSet([
      { row: { name: "dashboard.html", contentType: "text/html", size: 120 }, text: "<html>hi</html>" },
    ]);
    expect(block).toContain("DELIVERABLE:");
    expect(block).toContain("dashboard.html");
    expect(block).toContain("<html>hi</html>");
  });

  it("names the primary explicitly when several files are shown", () => {
    const block = renderDeliverableSet([
      { row: { name: "dashboard.html", contentType: "text/html", size: 120 }, text: "A" },
      { row: { name: "wireframes.html", contentType: "text/html", size: 90 }, text: "B" },
    ]);
    expect(block).toContain("DELIVERABLE SET (2 files");
    expect(block).toContain("FILE 1: dashboard.html");
    expect(block).toContain("FILE 2: wireframes.html");
  });

  it("truncates a huge file and says so", () => {
    const block = renderDeliverableSet([
      { row: { name: "big.html", contentType: "text/html", size: 999_999 }, text: "x".repeat(200_000) },
    ]);
    expect(block).toContain("truncated");
    expect(block.length).toBeLessThan(40_000);
  });
});

describe("isShrinkingReplacement", () => {
  it("rejects a sub-1 KB upload over a substantial prior version", () => {
    expect(isShrinkingReplacement(189, 13915)).toBe(true);
    expect(isShrinkingReplacement(292, 13915)).toBe(true);
  });

  it("allows a small first version, and any upload at or over the floor", () => {
    expect(isShrinkingReplacement(189, 0)).toBe(false);
    expect(isShrinkingReplacement(189, 500)).toBe(false);
    expect(isShrinkingReplacement(MIN_PRIMARY_BYTES, 13915)).toBe(false);
    expect(isShrinkingReplacement(20000, 13915)).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The paperwork regression: live task_9533y8685y7zginrepvk ("Deploy and Verify
// the Live Dashboard", verdict tver_obtdsulpx3gt2klm6i3k). The judge was shown
// dashboard.html AND three of the agent's own verification write-ups, and its
// PASS rationale leaned on them: "The reports confirm the resolution of SHA-256
// self-verification failures, the presence and 200 OK status of all 27 required
// backend endpoints". The brief's own vocabulary ("Verify", "Re-verification
// complete", "verified") had forgiven every paperwork token in those names.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_TITLE = "Deploy and Verify the Live Dashboard";
const LIVE_BODY =
  "Taking over stale deploy/verify card. Independent check found: SHA-256 self-verification failures on " +
  "dashboard.html and page-customizer-demo.html (footer hash did not match body hash). /generate and /analytics " +
  "endpoints missing from backend — both implemented and verified 200 OK. Re-verification complete 2026-09-13: " +
  "root cause was a stale server snapshot from /opt/data/workspace/backend (no dashboard/ dir — 404). Restarted " +
  "from /workspace/backend. 27/27 endpoints 200, SSE text/event-stream confirmed, 4/4 footer hashes MATCH. " +
  "Deploy still blocked on VERCEL_TOKEN.";

// Exactly the rows in task_artifacts for that task (collapsed to live versions).
const liveRows = (): DeliverableCandidate[] => [
  art({ name: "verify-dashboard-2026-09-13.md", contentType: "text/markdown", size: 1325 }),
  art({ name: "backend-full-verification-2026-09-13.md", size: 3046 }),
  art({ name: "dashboard-re-verification-2026-09-13.md", size: 896 }),
  art({ name: "dashboard-final-verification-2026-09-13.md", size: 1495 }),
  art({ name: "dashboard.html", contentType: "text/html", size: 13915, version: 5 }),
];

describe("paperworkAskedFor", () => {
  it("does not treat the brief merely USING the vocabulary as a request for it", () => {
    // This is the live bug in one assertion.
    const asked = paperworkAskedFor(LIVE_TITLE, LIVE_BODY);
    expect(asked.has("verify")).toBe(false);
    expect(asked.has("verification")).toBe(false);
    expect(asked.has("verified")).toBe(false);
  });

  it("forgives paperwork the brief actually asks for as a deliverable", () => {
    expect(paperworkAskedFor("Write a competitor research report", "")).toContain("report");
    expect(paperworkAskedFor("Q3 finance", "Produce an audit of the ledger")).toContain("audit");
    expect(paperworkAskedFor("Release 2.1", "Deliver a migration checklist for the team")).toContain("checklist");
  });

  it("does not reach across a sentence boundary", () => {
    expect(paperworkAskedFor("", "Write the dashboard. The audit is someone else's problem.")).not.toContain("audit");
  });
});

describe("isAncillaryName — broadened, extension-gated", () => {
  const none = new Set<string>();

  it("flags every paperwork name that was on the live card", () => {
    for (const n of [
      "verify-dashboard-2026-09-13.md",
      "backend-full-verification-2026-09-13.md",
      "dashboard-re-verification-2026-09-13.md",
      "dashboard-final-verification-2026-09-13.md",
    ]) {
      expect(isAncillaryName(n, none)).toBe(true);
    }
  });

  it("flags the other shapes agents attach", () => {
    expect(isAncillaryName("deployment-checklist.md", none)).toBe(true);
    expect(isAncillaryName("evidence-of-completion.txt", none)).toBe(true);
    expect(isAncillaryName("manifest.json", none)).toBe(true);
    expect(isAncillaryName("CHECKSUMS", none)).toBe(true);
    expect(isAncillaryName("status-2026-09-13.md", none)).toBe(true);
  });

  it("never flags the work itself, however it is named", () => {
    // The extension gate: a report ABOUT the work is prose, never the artifact.
    expect(isAncillaryName("final-status-dashboard.html", none)).toBe(false);
    expect(isAncillaryName("audit-tool.ts", none)).toBe(false);
    expect(isAncillaryName("verification-widget.tsx", none)).toBe(false);
    expect(isAncillaryName("dashboard.html", none)).toBe(false);
  });
});

describe("looksLikePaperworkText", () => {
  it("catches a body that is mostly hashes, checkmarks and 200 OKs", () => {
    const body = [
      "# Backend verification 2026-09-13",
      "GET /api/generate — 200 OK",
      "GET /api/analytics — 200 OK",
      "27/27 endpoints returned 200",
      "dashboard.html sha256 3b1f0c7ad4e5b6981223aa4455661f0e9a7c8d2e3f405162738495a6b7c8d9e0 MATCH",
      "4/4 footer hashes MATCH",
      "✅ SSE text/event-stream confirmed",
      "✅ All checks verified",
    ].join("\n");
    expect(looksLikePaperworkText(body)).toBe(true);
  });

  it("leaves real prose and real work alone", () => {
    const research = [
      "# Competitor pricing",
      "Acme charges $29 per seat per month, billed annually, with a 14-day trial.",
      "Globex bundles the same features into a flat $199 team plan and does not meter seats.",
      "The gap matters most below ten seats, where Acme is cheaper and Globex is not.",
      "Recommendation: price at $19 per seat and cap the team plan at $149.",
    ].join("\n");
    expect(looksLikePaperworkText(research)).toBe(false);
    expect(looksLikePaperworkText("<html><body><h1>Dashboard</h1><div id=app></div></body></html>")).toBe(false);
  });

  it("never decides on a file too short to have a majority", () => {
    expect(looksLikePaperworkText("200 OK\n200 OK")).toBe(false);
    expect(looksLikePaperworkText("")).toBe(false);
  });
});

describe("selectDeliverables — live task_9533y8685y7zginrepvk", () => {
  it("judges dashboard.html alone and excludes all four verification write-ups", () => {
    const sel = selectDeliverables(liveRows(), LIVE_TITLE, LIVE_BODY);
    expect(sel.primary?.name).toBe("dashboard.html");
    expect(sel.set.map((r) => r.name)).toEqual(["dashboard.html"]);
    expect(sel.paperwork.map((r) => r.name).sort()).toEqual([
      "backend-full-verification-2026-09-13.md",
      "dashboard-final-verification-2026-09-13.md",
      "dashboard-re-verification-2026-09-13.md",
      "verify-dashboard-2026-09-13.md",
    ]);
  });

  it("still judges the paperwork when it is ALL there is", () => {
    const only = liveRows().filter((r) => r.name.endsWith(".md"));
    const sel = selectDeliverables(only, LIVE_TITLE, LIVE_BODY);
    expect(sel.primary).not.toBeNull();
    expect(sel.paperwork).toEqual([]);
  });

  it("a report the brief ASKED for is a deliverable, not paperwork", () => {
    const rows = [
      art({ name: "competitor-research-report.md", size: 14000 }),
      art({ name: "verification-notes.md", size: 9000 }),
    ];
    const sel = selectDeliverables(rows, "Write a competitor research report", "Cover pricing and positioning.");
    expect(sel.primary?.name).toBe("competitor-research-report.md");
    expect(sel.paperwork.map((r) => r.name)).toEqual(["verification-notes.md"]);
  });
});

describe("renderPaperworkNotice", () => {
  it("names the withheld files and tells the judge they are not evidence", () => {
    const notice = renderPaperworkNotice([
      "verify-dashboard-2026-09-13.md",
      "backend-full-verification-2026-09-13.md",
    ]);
    expect(notice).toContain("NOT EVIDENCE");
    expect(notice).toContain("verify-dashboard-2026-09-13.md");
    expect(notice).toContain("backend-full-verification-2026-09-13.md");
    expect(notice).toContain(PAPERWORK_PROMPT_LINE);
  });

  it("is empty when nothing was withheld", () => {
    expect(renderPaperworkNotice([])).toBe("");
  });

  it("rides along with the deliverable block without leaking any paperwork BODY", () => {
    const block = renderDeliverableSet(
      [{ row: { name: "dashboard.html", contentType: "text/html", size: 13915 }, text: "<h1>Dashboard</h1>" }],
      ["backend-full-verification-2026-09-13.md"],
    );
    expect(block).toContain("FILE 1: dashboard.html");
    expect(block).toContain("backend-full-verification-2026-09-13.md");
    expect(block).toContain(PAPERWORK_PROMPT_LINE);
    expect(block).not.toContain("200 OK");
  });
});
