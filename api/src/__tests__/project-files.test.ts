import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugifyProject,
  sanitizeProjectFileName,
  parseProjectFile,
  serializeProjectFile,
  applyProjectWrite,
  renderProjectIndex,
  matchProjectFiles,
  writeProjectFile,
  loadProjectIndex,
  buildProjectContext,
  rankBySimilarity,
  PROJECT_FILE_MAX_CHARS,
  type ProjectInfo,
  type ProjectFileInfo,
} from "../lib/project-files.js";

describe("slugifyProject", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyProject("Neu Website Redesign!")).toBe("neu-website-redesign");
  });
  it("trims leading/trailing separators and caps length", () => {
    expect(slugifyProject("  --Hello.World--  ")).toBe("hello.world");
    expect(slugifyProject("x".repeat(80)).length).toBeLessThanOrEqual(48);
  });
  it("returns empty for junk", () => {
    expect(slugifyProject("!!!")).toBe("");
  });
});

describe("sanitizeProjectFileName", () => {
  it("strips path components and traversal", () => {
    expect(sanitizeProjectFileName("../../etc/passwd")).toBe("passwd.md");
    expect(sanitizeProjectFileName("sub/dir/status.md")).toBe("status.md");
  });
  it("forces a markdown extension", () => {
    expect(sanitizeProjectFileName("decisions")).toBe("decisions.md");
    expect(sanitizeProjectFileName("notes.txt")).toBe("notes.txt");
  });
  it("uses the fallback when empty", () => {
    expect(sanitizeProjectFileName(undefined)).toBe("log.md");
    expect(sanitizeProjectFileName(undefined, "status.md")).toBe("status.md");
  });
});

describe("frontmatter parse/serialize", () => {
  it("round-trips meta + body", () => {
    const text = serializeProjectFile(
      { summary: "Foundation brief", owner: "rachel", updatedBy: "phil", triggers: ["neu", "website"], always: true },
      "Body line one.\nBody line two.",
    );
    const { meta, body } = parseProjectFile(text);
    expect(meta.summary).toBe("Foundation brief");
    expect(meta.owner).toBe("rachel");
    expect(meta.updatedBy).toBe("phil");
    expect(meta.triggers).toEqual(["neu", "website"]);
    expect(meta.always).toBe(true);
    expect(body).toBe("Body line one.\nBody line two.");
  });
  it("treats a file with no frontmatter as body-only", () => {
    const { meta, body } = parseProjectFile("just some notes");
    expect(meta.owner).toBe("");
    expect(meta.triggers).toEqual([]);
    expect(body).toBe("just some notes");
  });
  it("strips a leading @ from owner/updated_by", () => {
    const { meta } = parseProjectFile("---\nowner: '@rachel'\n---\nx");
    expect(meta.owner).toBe("rachel");
  });
});

describe("applyProjectWrite", () => {
  it("creates a new file with attribution on append", () => {
    const r = applyProjectWrite(null, {
      mode: "append",
      note: "Picked the indigo palette.",
      actorHandle: "rachel",
      dateLabel: "2026-06-19 10:00",
      summary: "decisions",
    });
    expect("content" in r).toBe(true);
    if ("content" in r) {
      expect(r.content).toContain("## 2026-06-19 10:00 · @rachel");
      expect(r.content).toContain("Picked the indigo palette.");
      const { meta } = parseProjectFile(r.content);
      expect(meta.owner).toBe("rachel");
      expect(meta.summary).toBe("decisions");
    }
  });

  it("appends a second attributed entry, preserving the first", () => {
    const first = applyProjectWrite(null, { mode: "append", note: "Entry one.", actorHandle: "rachel", dateLabel: "d1" });
    if (!("content" in first)) throw new Error("expected content");
    const second = applyProjectWrite(first.content, {
      mode: "append",
      note: "Entry two.",
      actorHandle: "phil",
      dateLabel: "d2",
    });
    if (!("content" in second)) throw new Error("expected content");
    expect(second.content).toContain("Entry one.");
    expect(second.content).toContain("Entry two.");
    expect(second.content).toContain("@phil");
    // owner stays the creator; updated_by becomes the latest writer
    const { meta } = parseProjectFile(second.content);
    expect(meta.owner).toBe("rachel");
    expect(meta.updatedBy).toBe("phil");
  });

  it("append is always allowed even on a file owned by someone else", () => {
    const owned = serializeProjectFile(
      { summary: "s", owner: "rachel", updatedBy: "rachel", triggers: [], always: false },
      "original",
    );
    const r = applyProjectWrite(owned, { mode: "append", note: "addition", actorHandle: "phil", dateLabel: "d" });
    expect("content" in r).toBe(true);
  });

  it("replace is owner-gated: rejects a non-owner", () => {
    const owned = serializeProjectFile(
      { summary: "s", owner: "rachel", updatedBy: "rachel", triggers: [], always: false },
      "original",
    );
    const r = applyProjectWrite(owned, { mode: "replace", note: "rewrite", actorHandle: "phil", dateLabel: "d" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("owns this file");
  });

  it("replace allowed for the owner; overwrites the body", () => {
    const owned = serializeProjectFile(
      { summary: "s", owner: "rachel", updatedBy: "rachel", triggers: [], always: false },
      "original body",
    );
    const r = applyProjectWrite(owned, { mode: "replace", note: "fresh body", actorHandle: "rachel", dateLabel: "d" });
    if (!("content" in r)) throw new Error("expected content");
    const { body } = parseProjectFile(r.content);
    expect(body).toBe("fresh body");
  });

  it("rejects an empty note", () => {
    const r = applyProjectWrite(null, { mode: "append", note: "   ", actorHandle: "rachel", dateLabel: "d" });
    expect("error" in r).toBe(true);
  });

  it("enforces the per-file char cap", () => {
    const big = "x".repeat(PROJECT_FILE_MAX_CHARS + 100);
    const r = applyProjectWrite(null, { mode: "replace", note: big, actorHandle: "rachel", dateLabel: "d" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("limit");
  });
});

describe("renderProjectIndex", () => {
  const projects: ProjectInfo[] = [
    {
      slug: "neu-website",
      owner: "rachel",
      files: [
        {
          name: "status.md",
          path: "/x/neu-website/status.md",
          summary: "Current focus",
          owner: "rachel",
          updatedBy: "phil",
          triggers: ["neu"],
          always: true,
          size: 800,
          mtimeMs: 2,
        },
        {
          name: "brief.md",
          path: "/x/neu-website/brief.md",
          summary: "Foundation",
          owner: "rachel",
          updatedBy: "rachel",
          triggers: [],
          always: false,
          size: 2100,
          mtimeMs: 1,
        },
      ],
    },
  ];

  it("renders one line per project + file with owner and summary", () => {
    const out = renderProjectIndex(projects);
    expect(out).toContain("◆ neu-website (owner @rachel)");
    expect(out).toContain("status.md — Current focus");
    expect(out).toContain("brief.md — Foundation");
  });

  it("returns empty string when there are no projects", () => {
    expect(renderProjectIndex([])).toBe("");
  });

  it("respects the char cap", () => {
    const out = renderProjectIndex(projects, 30);
    expect(out.length).toBeLessThanOrEqual(30 + "\n…(index truncated)".length);
  });
});

describe("matchProjectFiles", () => {
  const projects: ProjectInfo[] = [
    {
      slug: "neu-website",
      owner: "rachel",
      files: [
        { name: "status.md", path: "p1", summary: "", owner: "r", updatedBy: "r", triggers: [], always: true, size: 1, mtimeMs: 3 },
        { name: "decisions.md", path: "p2", summary: "", owner: "r", updatedBy: "r", triggers: ["palette", "brand"], always: false, size: 1, mtimeMs: 2 },
        { name: "changelog.md", path: "p3", summary: "", owner: "r", updatedBy: "r", triggers: [], always: false, size: 1, mtimeMs: 1 },
      ],
    },
  ];

  it("always-injects always:true files regardless of text", () => {
    const out = matchProjectFiles(projects, "totally unrelated");
    expect(out.map((f) => f.name)).toContain("status.md");
    expect(out.map((f) => f.name)).not.toContain("changelog.md");
  });

  it("matches on a trigger keyword", () => {
    const out = matchProjectFiles(projects, "let's lock the brand palette");
    expect(out.map((f) => f.name)).toContain("decisions.md");
  });

  it("matches every file when the project slug appears in the text", () => {
    const out = matchProjectFiles(projects, "working on neu-website today");
    expect(out.map((f) => f.name).sort()).toEqual(["changelog.md", "decisions.md", "status.md"]);
  });

  it("matches on the file basename", () => {
    const out = matchProjectFiles(projects, "what's in the changelog?");
    expect(out.map((f) => f.name)).toContain("changelog.md");
  });

  it("orders freshest first", () => {
    const out = matchProjectFiles(projects, "neu-website");
    expect(out[0].name).toBe("status.md"); // mtime 3
  });
});

describe("rankBySimilarity (pure semantic ranker)", () => {
  const mk = (name: string): ProjectFileInfo => ({
    name,
    path: `/x/${name}`,
    summary: "",
    owner: "r",
    updatedBy: "r",
    triggers: [],
    always: false,
    size: 1,
    mtimeMs: 1,
  });

  it("keeps files above the floor, best-first, capped to topN", () => {
    const q = [1, 0];
    const out = rankBySimilarity(
      q,
      [
        { file: mk("exact.md"), vec: [1, 0] }, // cosine 1.0
        { file: mk("near.md"), vec: [0.8, 0.6] }, // cosine 0.8
        { file: mk("ortho.md"), vec: [0, 1] }, // cosine 0
      ],
      0.5,
      2,
    );
    expect(out.map((f) => f.name)).toEqual(["exact.md", "near.md"]);
  });

  it("drops candidates whose embedding failed (null vec)", () => {
    const out = rankBySimilarity(
      [1, 0],
      [
        { file: mk("good.md"), vec: [1, 0] },
        { file: mk("failed.md"), vec: null },
      ],
      0.5,
      5,
    );
    expect(out.map((f) => f.name)).toEqual(["good.md"]);
  });

  it("returns nothing when all candidates fall below the floor", () => {
    const out = rankBySimilarity([1, 0], [{ file: mk("a.md"), vec: [0.1, 0.99] }], 0.6, 5);
    expect(out).toEqual([]);
  });
});

// ── fs-touching round trip against a temp mount ──
describe("writeProjectFile + loadProjectIndex (temp mount)", () => {
  let mount = "";
  beforeEach(async () => {
    mount = await fsp.mkdtemp(join(tmpdir(), "cc-proj-"));
    process.env.CC_WORKSPACE_MOUNT = mount;
  });
  afterEach(async () => {
    delete process.env.CC_WORKSPACE_MOUNT;
    await fsp.rm(mount, { recursive: true, force: true }).catch(() => {});
  });

  it("creates the file on disk, then loads + injects it", async () => {
    const w = await writeProjectFile({
      project: "Neu Website",
      file: "status.md",
      note: "Homepage redesign in review.",
      summary: "Current status",
      triggers: ["neu"],
      actorHandle: "rachel",
    });
    expect("ok" in w).toBe(true);
    if ("ok" in w) {
      expect(w.path).toBe("projects/neu-website/status.md");
      expect(w.created).toBe(true);
    }

    const onDisk = await fsp.readFile(join(mount, "projects", "neu-website", "status.md"), "utf8");
    expect(onDisk).toContain("Homepage redesign in review.");
    expect(onDisk).toContain("@rachel");

    const index = await loadProjectIndex();
    expect(index.length).toBe(1);
    expect(index[0].slug).toBe("neu-website");
    expect(index[0].files[0].summary).toBe("Current status");

    const ctx = await buildProjectContext("anything about neu today");
    expect(ctx.index).toContain("neu-website");
    expect(ctx.files.map((f) => f.name)).toContain("status.md");
    expect(ctx.files[0].content).toContain("Homepage redesign in review.");
  });

  it("a second agent can append; owner-gated replace is rejected", async () => {
    await writeProjectFile({ project: "neu", file: "brief.md", note: "Goals.", actorHandle: "rachel", mode: "replace" });
    const append = await writeProjectFile({ project: "neu", file: "brief.md", note: "More.", actorHandle: "phil" });
    expect("ok" in append).toBe(true);
    const replace = await writeProjectFile({
      project: "neu",
      file: "brief.md",
      note: "Hostile rewrite.",
      actorHandle: "phil",
      mode: "replace",
    });
    expect("error" in replace).toBe(true);
    if ("error" in replace) expect(replace.error).toContain("owns this file");
  });

  it("writes a derived INDEX.md that excludes itself", async () => {
    await writeProjectFile({ project: "neu", file: "status.md", note: "x", actorHandle: "rachel" });
    const idx = await fsp.readFile(join(mount, "projects", "INDEX.md"), "utf8");
    expect(idx).toContain("neu");
    // INDEX.md must not list itself as a tracked file
    const index = await loadProjectIndex();
    expect(index[0].files.map((f) => f.name)).not.toContain("INDEX.md");
  });
});

// ── append dedupe + rolling compaction + tail-first injection ──
import { splitEntries, compactEntries, excerptForInjection, KEEP_ENTRIES, COMPACT_AT_CHARS } from "../lib/project-files.js";

function buildLog(n: number, noteFor: (i: number) => string, head = ""): string {
  let cur: string | null = head ? serializeProjectFile({ summary: "", owner: "rachel", updatedBy: "rachel", triggers: [], always: false }, head) : null;
  for (let i = 0; i < n; i++) {
    const r = applyProjectWrite(cur, { mode: "append", note: noteFor(i), actorHandle: i % 2 ? "iris" : "nova", dateLabel: `2026-09-0${(i % 9) + 1} 10:${String(i % 60).padStart(2, "0")}` });
    if (!("content" in r)) throw new Error(`append ${i} failed: ${(r as { error: string }).error}`);
    cur = r.content;
  }
  return cur as string;
}

describe("splitEntries", () => {
  it("separates a free-form head from dated provenance entries", () => {
    const body = "Brief: showcase site.\n\n## 2026-09-01 10:00 · @nova\nRelay live.\n\n## 2026-09-02 11:00 · @iris\nHashes recomputed.";
    const { head, entries } = splitEntries(body);
    expect(head).toBe("Brief: showcase site.");
    expect(entries).toHaveLength(2);
    expect(entries[1]).toContain("Hashes recomputed.");
  });
  it("treats a body without provenance headers as head only", () => {
    expect(splitEntries("## Goals\nShip it.").entries).toHaveLength(0);
  });
});

describe("applyProjectWrite — append dedupe", () => {
  it("refuses a near-duplicate of a recent entry, even from another agent", () => {
    const first = applyProjectWrite(null, {
      mode: "append",
      note: "Self-hosted HLS relay verified live — all three streams resolve and the manifest is cached at the edge.",
      actorHandle: "nova",
      dateLabel: "2026-09-04 09:00",
    });
    if (!("content" in first)) throw new Error("expected content");
    const dup = applyProjectWrite(first.content, {
      mode: "append",
      note: "**Self-hosted HLS relay verified live** — all three streams resolve and the manifest is cached at the edge (cc @iris).",
      actorHandle: "iris",
      dateLabel: "2026-09-04 11:30",
    });
    expect("error" in dup).toBe(true);
    if ("error" in dup) expect(dup.error).toMatch(/near-duplicate.*@nova/);
  });

  it("accepts a genuinely new fact", () => {
    const first = applyProjectWrite(null, {
      mode: "append",
      note: "Self-hosted HLS relay verified live — all three streams resolve and the manifest is cached at the edge.",
      actorHandle: "nova",
      dateLabel: "d1",
    });
    if (!("content" in first)) throw new Error("expected content");
    const next = applyProjectWrite(first.content, {
      mode: "append",
      note: "Decision: drop the CDN fallback; the relay alone meets the latency budget (p95 1.8s).",
      actorHandle: "iris",
      dateLabel: "d2",
    });
    expect("content" in next).toBe(true);
  });

  it("caps a single appended entry at half the file limit", () => {
    const r = applyProjectWrite(null, { mode: "append", note: "y".repeat(PROJECT_FILE_MAX_CHARS / 2 + 1), actorHandle: "nova", dateLabel: "d" });
    expect("error" in r).toBe(true);
  });
});

describe("rolling compaction", () => {
  it("keeps at most KEEP_ENTRIES entries and reports the archived ones", () => {
    const content = buildLog(KEEP_ENTRIES + 5, (i) => `Distinct milestone number ${i}: ${["alpha", "beta", "gamma", "delta", "epsilon"][i % 5]} stage ${i * 7} reached with ${i * 3} checks passing.`);
    const { entries } = splitEntries(parseProjectFile(content).body);
    expect(entries.length).toBe(KEEP_ENTRIES);
    // newest survives, oldest is gone
    expect(content).toContain(`Distinct milestone number ${KEEP_ENTRIES + 4}:`);
    expect(content).not.toContain("Distinct milestone number 0:");
  });

  it("compacts by size when entries are long, never below the minimum", () => {
    const head = "Brief: keep me.";
    const long = (i: number) => `Entry ${i} ` + `unique-${i}-word `.repeat(30); // ~450 chars each
    const entries = Array.from({ length: 20 }, (_, i) => `## d${i} · @nova\n${long(i)}`);
    const { body, archived } = compactEntries(head, entries);
    expect(body.length).toBeLessThanOrEqual(COMPACT_AT_CHARS);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.length + splitEntries(body).entries.length).toBe(20);
    // Never below the minimum even when entries are huge.
    const huge = Array.from({ length: 12 }, (_, i) => `## d${i} · @nova\nEntry ${i} ` + "w ".repeat(1500));
    expect(splitEntries(compactEntries("", huge).body).entries.length).toBe(8);
    expect(body.startsWith(head)).toBe(true);
    expect(body).toContain("Entry 19 ");
  });

  it("writes archived entries to <project>/archive/<file> on disk and keeps them out of the index", async () => {
    const mount = join(tmpdir(), `cc-proj-archive-${process.pid}-${Date.now()}`);
    process.env.CC_WORKSPACE_MOUNT = mount;
    try {
      for (let i = 0; i < KEEP_ENTRIES + 2; i++) {
        const r = await writeProjectFile({
          project: "arch-test",
          file: "status.md",
          note: `Milestone ${i}: ${["alpha", "beta", "gamma"][i % 3]} stage ${i * 11} done, ${i + 2} checks green.`,
          actorHandle: "nova",
        });
        expect("ok" in r).toBe(true);
      }
      const arch = await fsp.readFile(join(mount, "projects", "arch-test", "archive", "status.md"), "utf8");
      expect(arch).toContain("Milestone 0:");
      const live = await fsp.readFile(join(mount, "projects", "arch-test", "status.md"), "utf8");
      expect(live).not.toContain("Milestone 0:");
      const idx = await loadProjectIndex();
      expect(idx.find((p) => p.slug === "arch-test")?.files.map((f) => f.name)).toEqual(["status.md"]);
    } finally {
      delete process.env.CC_WORKSPACE_MOUNT;
      await fsp.rm(mount, { recursive: true, force: true });
    }
  });
});

describe("excerptForInjection", () => {
  it("injects the NEWEST entries (plus head) when a log exceeds the cap", () => {
    const body = ["Brief: showcase site.", ...Array.from({ length: 40 }, (_, i) => `## 2026-09-01 10:${String(i).padStart(2, "0")} · @nova\nEntry ${i} ` + "filler ".repeat(20))].join("\n\n");
    const out = excerptForInjection(body, 1600);
    expect(out.length).toBeLessThanOrEqual(1600);
    expect(out.startsWith("Brief: showcase site.")).toBe(true);
    expect(out).toContain("Entry 39 ");
    expect(out).not.toContain("Entry 0 ");
    expect(out).toMatch(/older entries omitted/);
  });
  it("returns a short body untouched and head-slices a plain document", () => {
    expect(excerptForInjection("short body", 100)).toBe("short body");
    expect(excerptForInjection("a".repeat(300), 100)).toBe("a".repeat(100));
  });
});
