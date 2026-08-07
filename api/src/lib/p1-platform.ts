import { z } from "zod";

export const DECISION_KINDS = ["decision", "precedent", "policy", "exception", "steer"] as const;
export const BOARD_STAGE_KEYS = ["backlog", "in_progress", "blocked", "review", "done"] as const;

export const StageRulesSchema = z.object({
  requireAssignee: z.boolean().optional(),
  requiredLabels: z.array(z.string().min(1).max(40)).max(20).optional(),
  minProgress: z.number().int().min(0).max(100).optional(),
  requireArtifact: z.boolean().optional(),
  requireVerification: z.boolean().optional(),
}).strict();

export type StageRules = z.infer<typeof StageRulesSchema>;

export function evaluateStageRules(
  rules: StageRules,
  context: {
    assignees: string[];
    labels: string[];
    progress: number;
    artifactCount: number;
    verificationPassed: boolean;
  },
): string[] {
  const violations: string[] = [];
  if (rules.requireAssignee && context.assignees.length === 0) violations.push("assignee_required");
  for (const label of rules.requiredLabels ?? []) {
    if (!context.labels.includes(label)) violations.push(`label_required:${label}`);
  }
  if (rules.minProgress !== undefined && context.progress < rules.minProgress) {
    violations.push(`progress_below:${rules.minProgress}`);
  }
  if (rules.requireArtifact && context.artifactCount === 0) violations.push("artifact_required");
  if (rules.requireVerification && !context.verificationPassed) violations.push("verification_required");
  return violations;
}
const BlueprintAgent = z.object({
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(100),
  handle: z.string().min(2).max(40),
  title: z.string().max(160).optional(),
  brief: z.string().max(10_000).optional(),
  capabilities: z.array(z.string().max(80)).max(50).optional(),
  scopes: z.array(z.string().max(80)).max(50).optional(),
  budgetUsdMonth: z.number().nonnegative().nullable().optional(),
});

export const TeamBlueprintSchema = z.object({
  agents: z.array(BlueprintAgent).max(100).default([]),
  relationships: z.array(z.object({ childKey: z.string(), parentKey: z.string().nullable() })).max(200).default([]),
  skills: z.array(z.object({ agentKey: z.string(), name: z.string(), content: z.string().max(100_000).optional() })).max(300).default([]),
  channels: z.array(z.object({ name: z.string().min(1).max(100), topic: z.string().max(500).optional(), memberKeys: z.array(z.string()).optional() })).max(100).default([]),
  workflows: z.array(z.object({ name: z.string().min(1).max(140), description: z.string().max(3_000).optional(), triggerType: z.enum(["manual", "webhook"]).optional(), definition: z.unknown() })).max(100).default([]),
});

export type TeamBlueprintInput = z.infer<typeof TeamBlueprintSchema>;

export type NormalizedPrSnapshot = {
  title: string;
  url: string;
  state: string;
  headRef: string;
  baseRef: string;
  diff: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  protection: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Accepts the provider API shapes or a connector that has already grouped the
// individual API responses into {pull|mergeRequest, files, checks, reviews,
// protection}. Keeping normalization pure makes both providers deterministic
// and lets connector fixtures exercise the full PR-room path without network.
export function normalizePrSnapshot(provider: "github" | "gitlab", raw: unknown): NormalizedPrSnapshot {
  const root = record(raw);
  if (provider === "github") {
    const pr = record(root.pull ?? root.pr ?? root);
    return {
      title: text(pr.title),
      url: text(pr.html_url ?? pr.url),
      state: text(pr.merged_at ? "merged" : pr.state) || "open",
      headRef: text(record(pr.head).ref ?? pr.head_ref),
      baseRef: text(record(pr.base).ref ?? pr.base_ref),
      diff: records(root.files ?? pr.files),
      checks: records(root.checks ?? root.check_runs),
      reviews: records(root.reviews),
      protection: record(root.protection ?? root.branch_protection),
    };
  }
  const mr = record(root.mergeRequest ?? root.merge_request ?? root);
  const changes = record(root.changes ?? mr.changes);
  return {
    title: text(mr.title),
    url: text(mr.web_url ?? mr.url),
    state: text(mr.state) || "opened",
    headRef: text(mr.source_branch),
    baseRef: text(mr.target_branch),
    diff: records(changes.changes ?? root.files),
    checks: records(root.pipelines ?? root.checks),
    reviews: records(root.approvals ?? root.reviews),
    protection: record(root.protection ?? root.protected_branch),
  };
}

export function safeSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "app";
}

export function appContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "img-src data: https:",
    "font-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}
