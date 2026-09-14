import { describe, it, expect } from "vitest";
import {
  collapseVersions,
  deliverableSetKey,
  expectedKinds,
  isAncillaryName,
  scoreDeliverables,
  selectDeliverables,
  MIN_PRIMARY_BYTES,
  type DeliverableCandidate,
} from "../lib/deliverable-select.js";
import { renderDeliverableSet } from "../lib/task-verifier.js";
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
