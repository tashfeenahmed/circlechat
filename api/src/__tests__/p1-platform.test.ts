import { describe, expect, it } from "vitest";
import { permits } from "../lib/access-control.js";
import {
  appContentSecurityPolicy,
  evaluateStageRules,
  normalizePrSnapshot,
  safeSlug,
  StageRulesSchema,
  TeamBlueprintSchema,
} from "../lib/p1-platform.js";

describe("executable board stages", () => {
  it("reports every unmet entry and exit contract deterministically", () => {
    const rules = StageRulesSchema.parse({
      requireAssignee: true,
      requiredLabels: ["security", "release"],
      minProgress: 80,
      requireArtifact: true,
      requireVerification: true,
    });
    expect(evaluateStageRules(rules, {
      assignees: [], labels: ["security"], progress: 50, artifactCount: 0, verificationPassed: false,
    })).toEqual([
      "assignee_required",
      "label_required:release",
      "progress_below:80",
      "artifact_required",
      "verification_required",
    ]);
  });

  it("rejects unknown rule keys instead of silently ignoring policy typos", () => {
    expect(() => StageRulesSchema.parse({ requireArtfact: true })).toThrow();
  });
});
describe("team blueprints", () => {
  it("validates every packaged resource family", () => {
    const result = TeamBlueprintSchema.parse({
      agents: [{ key: "lead", name: "Lead", handle: "lead", scopes: ["tasks.write"], budgetUsdMonth: 25 }],
      relationships: [{ childKey: "lead", parentKey: null }],
      skills: [{ agentKey: "lead", name: "release", content: "Verify, then ship." }],
      channels: [{ name: "release", memberKeys: ["lead"] }],
      workflows: [{ name: "Ship", definition: { start: "done", states: [{ id: "done", type: "terminal" }] } }],
    });
    expect(result.agents[0].budgetUsdMonth).toBe(25);
    expect(result.channels[0].memberKeys).toEqual(["lead"]);
  });
});

describe("provider PR normalization", () => {
  it("normalizes GitHub PR, checks, reviews, files, and protection", () => {
    const snapshot = normalizePrSnapshot("github", {
      pull: { title: "Ship", html_url: "https://github.test/acme/app/pull/7", state: "open", head: { ref: "feature" }, base: { ref: "main" } },
      files: [{ filename: "src/app.ts", additions: 5 }],
      checks: [{ name: "test", conclusion: "success" }],
      reviews: [{ state: "APPROVED" }],
      protection: { required_status_checks: { strict: true } },
    });
    expect(snapshot).toMatchObject({ title: "Ship", headRef: "feature", baseRef: "main", state: "open" });
    expect(snapshot.diff).toHaveLength(1);
    expect(snapshot.checks).toHaveLength(1);
    expect(snapshot.reviews).toHaveLength(1);
    expect(snapshot.protection).toHaveProperty("required_status_checks");
  });

  it("normalizes GitLab merge requests and changes", () => {
    const snapshot = normalizePrSnapshot("gitlab", {
      mergeRequest: { title: "Merge", web_url: "https://gitlab.test/a/b/-/merge_requests/3", state: "merged", source_branch: "feat", target_branch: "main" },
      changes: { changes: [{ old_path: "a", new_path: "b" }] },
      pipelines: [{ status: "success" }], approvals: [{ user: { name: "Ada" } }],
    });
    expect(snapshot).toMatchObject({ title: "Merge", state: "merged", headRef: "feat", baseRef: "main" });
    expect(snapshot.diff).toHaveLength(1);
  });
});

describe("app isolation and RBAC helpers", () => {
  it("uses stable safe slugs and a deny-by-default CSP", () => {
    expect(safeSlug("  My <App>  ")).toBe("my-app");
    expect(appContentSecurityPolicy()).toContain("default-src 'none'");
    expect(appContentSecurityPolicy()).toContain("connect-src 'none'");
    expect(appContentSecurityPolicy()).toContain("form-action 'none'");
  });

  it("recognizes explicit permissions and admin wildcard only", () => {
    expect(permits(["runs.control"], "runs.control")).toBe(true);
    expect(permits(["workspace.read"], "runs.control")).toBe(false);
    expect(permits(["*"], "audit.export")).toBe(true);
  });
});
