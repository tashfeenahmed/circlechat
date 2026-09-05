import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeScope,
  credentialNames,
  isCredentialAsk,
  scopeMatches,
  autoApprovalFor,
  approvalExpiresAt,
  isApprovalExpired,
  expiryNote,
  denialMemoryMs,
  pickDuplicate,
  duplicateApprovalError,
} from "../lib/approval-policy.js";
import { approvalTtlHours, approvalDenialMemoryDays, autoApproveScopes } from "../lib/config.js";

// Env-driven knobs: save/restore around each test.
const ENV = ["APPROVAL_TTL_HOURS", "APPROVAL_DEFAULT_TTL", "APPROVAL_DENIAL_MEMORY_DAYS", "AUTO_APPROVE_SCOPES"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("config readers", () => {
  it("default: 72h TTL, 7-day denial memory, nothing auto-approved", () => {
    expect(approvalTtlHours()).toBe(72);
    expect(approvalDenialMemoryDays()).toBe(7);
    expect(autoApproveScopes()).toEqual([]);
  });
  it("APPROVAL_TTL_HOURS wins over the APPROVAL_DEFAULT_TTL alias; 0 disables; junk falls back", () => {
    process.env.APPROVAL_DEFAULT_TTL = "24";
    expect(approvalTtlHours()).toBe(24);
    process.env.APPROVAL_TTL_HOURS = "6";
    expect(approvalTtlHours()).toBe(6);
    process.env.APPROVAL_TTL_HOURS = "0";
    expect(approvalTtlHours()).toBe(0);
    expect(approvalExpiresAt(new Date(), approvalTtlHours())).toBeNull();
    process.env.APPROVAL_TTL_HOURS = "banana";
    expect(approvalTtlHours()).toBe(72);
  });
  it("AUTO_APPROVE_SCOPES is a trimmed, lower-cased comma list", () => {
    process.env.AUTO_APPROVE_SCOPES = " Deploy, tasks.* ,,RISK:medium ";
    expect(autoApproveScopes()).toEqual(["deploy", "tasks.*", "risk:medium"]);
  });
});

describe("scope + credential matching (dedupe, task a)", () => {
  it("normalises free-form scopes to one key", () => {
    expect(normalizeScope("Tavily API key")).toBe("tavily_api_key");
    expect(normalizeScope("TAVILY_API_KEY")).toBe("tavily_api_key");
    expect(normalizeScope("tavily-api-key ")).toBe("tavily_api_key");
    expect(normalizeScope("tasks.write")).toBe("tasks.write");
    expect(normalizeScope("risk:medium")).toBe("risk:medium");
  });

  it("extracts env-var-shaped credential names from scope and action", () => {
    expect(credentialNames("tavily_api_key", "Need a search key")).toEqual(["TAVILY_API_KEY"]);
    expect(credentialNames("deploy", "Please provision VERCEL_TOKEN so I can ship")).toEqual(["VERCEL_TOKEN"]);
    expect(credentialNames("github", "a GITHUB_PAT with repo scope")).toEqual(["GITHUB_PAT"]);
    expect(credentialNames("deploy", "publish the site")).toEqual([]);
  });

  it("flags credential asks (never auto-approvable)", () => {
    expect(isCredentialAsk("tavily_api_key", "")).toBe(true);
    expect(isCredentialAsk("deploy", "need the Vercel token")).toBe(true);
    expect(isCredentialAsk("deploy", "publish the landing page to the preview host")).toBe(false);
  });

  const req = { agentId: "ag_a", scope: "tavily_api_key", action: "Provision a Tavily API key for web research" };
  const row = (over: Partial<Parameters<typeof pickDuplicate>[0][number]>) => ({
    id: "ap_x",
    status: "pending",
    agentId: "ag_a",
    decidedAt: null,
    decisionNote: null,
    action: "",
    scope: "",
    sim: 0,
    ...over,
  });

  it("matches the same scope even when the sentence is completely different", () => {
    const dup = pickDuplicate([row({ scope: "TAVILY_API_KEY", action: "search backend credentials please", sim: 0.05 })], req);
    expect(dup?.id).toBe("ap_x");
  });

  it("matches the same credential name under a different scope", () => {
    const dup = pickDuplicate(
      [row({ scope: "research_tools", action: "I need TAVILY_API_KEY to run searches", sim: 0.1 })],
      { ...req, scope: "web_search", action: "unblock research: TAVILY_API_KEY" },
    );
    expect(dup?.id).toBe("ap_x");
  });

  it("falls back to text similarity: looser for the same agent than for a teammate", () => {
    expect(pickDuplicate([row({ scope: "x", action: "…", sim: 0.5 })], { ...req, scope: "" })?.id).toBe("ap_x");
    expect(pickDuplicate([row({ scope: "x", action: "…", sim: 0.5, agentId: "ag_b" })], { ...req, scope: "" })).toBeNull();
    expect(pickDuplicate([row({ scope: "x", action: "…", sim: 0.7, agentId: "ag_b" })], { ...req, scope: "" })?.id).toBe("ap_x");
  });

  it("prefers a recent denial over a pending card for the same ask", () => {
    const denied = row({ id: "ap_denied", status: "denied", scope: "tavily_api_key", decidedAt: new Date("2026-07-04"), decisionNote: "No paid search APIs — use DuckDuckGo." });
    const pending = row({ id: "ap_pending", status: "pending", scope: "tavily_api_key" });
    const dup = pickDuplicate([pending, denied], req);
    expect(dup?.id).toBe("ap_denied");
    const msg = duplicateApprovalError("request_approval", dup!, "ag_a");
    expect(msg).toMatch(/DENIED/);
    expect(msg).toContain("2026-07-04");
    expect(msg).toContain("No paid search APIs — use DuckDuckGo.");
    expect(msg).toMatch(/do NOT re-request/);
  });

  it("returns null when nothing matches", () => {
    expect(pickDuplicate([row({ scope: "vercel_token", action: "ship to vercel", sim: 0.1 })], req)).toBeNull();
  });

  it("explains expired and teammate duplicates distinctly", () => {
    const expired = duplicateApprovalError("request_approval", { id: "ap_e", status: "expired", agentId: "ag_a", decidedAt: new Date("2026-08-01"), decisionNote: null, action: "x", scope: "s" }, "ag_a");
    expect(expired).toMatch(/EXPIRED/);
    expect(expired).toMatch(/Do NOT re-request/);
    const teammate = duplicateApprovalError("request_approval", { id: "ap_t", status: "pending", agentId: "ag_b", decidedAt: null, decisionNote: null, action: "x", scope: "s" }, "ag_a");
    expect(teammate).toMatch(/teammate/);
    const mine = duplicateApprovalError("request_approval", { id: "ap_m", status: "pending", agentId: "ag_a", decidedAt: null, decisionNote: null, action: "x", scope: "s" }, "ag_a");
    expect(mine).toMatch(/already pending/);
  });

  it("denial memory window is configurable", () => {
    expect(denialMemoryMs()).toBe(7 * 86_400_000);
    process.env.APPROVAL_DENIAL_MEMORY_DAYS = "30";
    expect(denialMemoryMs()).toBe(30 * 86_400_000);
  });
});

describe("expiry (task b)", () => {
  it("computes the deadline from created_at + TTL and detects expiry", () => {
    const created = new Date("2026-07-05T10:00:00Z");
    expect(approvalExpiresAt(created, 72)?.toISOString()).toBe("2026-07-08T10:00:00.000Z");
    expect(isApprovalExpired(created, new Date("2026-07-08T09:59:59Z"), 72)).toBe(false);
    expect(isApprovalExpired(created, new Date("2026-07-08T10:00:00Z"), 72)).toBe(true);
    expect(isApprovalExpired(created, new Date("2030-01-01"), 0)).toBe(false); // TTL 0 = never
  });
  it("the expiry note tells the agent not to re-request and to find another route", () => {
    const n = expiryNote(72);
    expect(n).toMatch(/EXPIRED/);
    expect(n).toMatch(/do NOT re-request/);
    expect(n).toMatch(/in-platform app preview/);
    expect(n).toMatch(/in_progress/);
  });
});

describe("auto-approval policy (task d)", () => {
  it("scopeMatches: exact, prefix wildcard, bare star", () => {
    expect(scopeMatches("deploy", "Deploy")).toBe(true);
    expect(scopeMatches("tasks.*", "tasks.write")).toBe(true);
    expect(scopeMatches("tasks.*", "channels.reply")).toBe(false);
    expect(scopeMatches("risk:*", "risk:medium")).toBe(true);
    expect(scopeMatches("*", "anything")).toBe(true);
    expect(scopeMatches("", "x")).toBe(false);
  });

  it("nothing is auto-approved by default", () => {
    expect(autoApprovalFor("deploy", "publish preview", [])).toBeNull();
    expect(autoApprovalFor("tasks.write", "create_task \"x\"", ["channels.reply"])).toBeNull();
  });

  it("AUTO_APPROVE_SCOPES covers matching scopes for every agent", () => {
    process.env.AUTO_APPROVE_SCOPES = "tasks.*,external_post";
    expect(autoApprovalFor("tasks.write", "task_comment on task_1", [])).toEqual({ by: "policy", rule: "tasks.*" });
    expect(autoApprovalFor("external_post", "post the changelog to the blog", [])).toEqual({ by: "policy", rule: "external_post" });
    expect(autoApprovalFor("risk:high", "share_files in c_1", [])).toBeNull();
  });

  it("per-agent trust via approve:<scope> / approve:* scopes", () => {
    expect(autoApprovalFor("deploy", "ship the preview", ["channels.reply", "approve:deploy"])).toEqual({ by: "agent_scope", rule: "approve:deploy" });
    expect(autoApprovalFor("anything_else", "do it", ["approve:*"])).toEqual({ by: "agent_scope", rule: "approve:*" });
    expect(autoApprovalFor("deploy", "ship", ["approve:tasks.*"])).toBeNull();
  });

  it("credential requests are never auto-approved, whatever the policy says", () => {
    process.env.AUTO_APPROVE_SCOPES = "*";
    expect(autoApprovalFor("tavily_api_key", "need a search key", ["approve:*"])).toBeNull();
    expect(autoApprovalFor("deploy", "please provide the VERCEL_TOKEN", ["approve:*"])).toBeNull();
    // …but a non-credential ask under the same wildcard is.
    expect(autoApprovalFor("deploy", "publish to the in-platform preview", [])).toEqual({ by: "policy", rule: "*" });
  });
});
