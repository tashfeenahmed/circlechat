import { describe, it, expect } from "vitest";
import { parseKnowledgeFrontmatter, selectKnowledge } from "../agents/context.js";

describe("parseKnowledgeFrontmatter", () => {
  it("parses a flow-list triggers line", () => {
    const r = parseKnowledgeFrontmatter("---\ntriggers: [deploy, Netlify, hosting]\n---\nUse the preview host.");
    expect(r.triggers).toEqual(["deploy", "netlify", "hosting"]);
    expect(r.always).toBe(false);
    expect(r.body).toBe("Use the preview host.");
  });

  it("parses a block-list triggers section", () => {
    const r = parseKnowledgeFrontmatter("---\ntriggers:\n  - brand\n  - logo\n---\nBrand rules here.");
    expect(r.triggers).toEqual(["brand", "logo"]);
    expect(r.body).toBe("Brand rules here.");
  });

  it("parses always: true", () => {
    const r = parseKnowledgeFrontmatter("---\nalways: true\n---\nAlways relevant.");
    expect(r.always).toBe(true);
  });

  it("treats a file with no frontmatter as body-only (always-on)", () => {
    const r = parseKnowledgeFrontmatter("Just some guidance, no frontmatter.");
    expect(r.triggers).toEqual([]);
    expect(r.always).toBe(false);
    expect(r.body).toBe("Just some guidance, no frontmatter.");
  });
});

describe("selectKnowledge", () => {
  const entries = [
    { name: "deploy.md", triggers: ["deploy", "netlify"], always: false, body: "DEPLOY GUIDE" },
    { name: "brand.md", triggers: ["brand", "logo"], always: false, body: "BRAND RULES" },
    { name: "always.md", triggers: [], always: true, body: "ALWAYS ON" },
    { name: "untriggered.md", triggers: [], always: false, body: "NO TRIGGERS" },
  ];

  it("injects always-on and no-trigger entries regardless of text", () => {
    const out = selectKnowledge(entries, "unrelated chatter");
    const names = out.map((o) => o.name);
    expect(names).toContain("always.md");
    expect(names).toContain("untriggered.md");
    expect(names).not.toContain("deploy.md");
    expect(names).not.toContain("brand.md");
  });

  it("injects a gated entry when its keyword appears (case-insensitive)", () => {
    const out = selectKnowledge(entries, "Can you DEPLOY the new landing page?");
    expect(out.map((o) => o.name)).toContain("deploy.md");
    expect(out.map((o) => o.name)).not.toContain("brand.md");
  });

  it("respects the total-chars cap", () => {
    const big = Array.from({ length: 10 }, (_, i) => ({
      name: `k${i}.md`,
      triggers: [],
      always: true,
      body: "x".repeat(2000),
    }));
    const out = selectKnowledge(big, "");
    const total = out.reduce((s, o) => s + o.content.length, 0);
    expect(total).toBeLessThanOrEqual(5000);
  });
});
