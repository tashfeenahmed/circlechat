// Server-side Composio integration. This is the ONE place the Composio SDK and
// the COMPOSIO_API_KEY live — the agent containers never see either. Agents
// discover and run Composio tools through /agent-api/composio/* + /agent-api/act
// (see routes/agent-api-composio.ts and the composio_execute executor action),
// so every outbound call inherits CircleChat's scope/risk/approval gating.
//
// Dormant by design: with COMPOSIO_API_KEY unset, composioEnabled() is false and
// every helper returns empty / throws composio_not_configured — no errors at
// boot, mirroring the planner/verifier "no key → feature off" convention.

import { Composio } from "@composio/core";

const API_KEY = process.env.COMPOSIO_API_KEY ?? "";

// The Composio user id (entity) whose connected accounts agents act as. A single
// workspace-wide identity for now — the deploy owner's connections. Per-agent
// identities are a natural follow-up (store the id on agents.config_json and
// thread it through composio_execute).
const DEFAULT_USER_ID = process.env.COMPOSIO_USER_ID?.trim() || "default";

// Optional allow-list of toolkits to expose (comma-separated slugs, e.g.
// "github,gmail,slack"). Empty → expose whatever the user has actually connected.
const CONFIGURED_TOOLKITS = (process.env.COMPOSIO_TOOLKITS ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export type ComposioApproval = "all" | "writes" | "off";

// Approval policy for composio_execute. Default "all": every outbound Composio
// call is routed through a human approval card. "writes" auto-runs read-only
// tools and gates the rest; "off" runs everything (still fully audit-logged).
export function composioApprovalPolicy(): ComposioApproval {
  const v = (process.env.COMPOSIO_APPROVAL ?? "all").trim().toLowerCase();
  if (v === "off" || v === "none") return "off";
  if (v === "writes" || v === "write") return "writes";
  return "all";
}

export function composioEnabled(): boolean {
  return API_KEY.length > 0;
}

export function composioUserId(): string {
  return DEFAULT_USER_ID;
}

export function composioConfiguredToolkits(): string[] {
  return CONFIGURED_TOOLKITS;
}

let _client: Composio | null = null;
function client(): Composio {
  if (!composioEnabled()) throw new Error("composio_not_configured");
  if (!_client) _client = new Composio({ apiKey: API_KEY });
  return _client;
}

export interface ComposioToolDef {
  // MCP tool name IS the Composio slug (e.g. GITHUB_CREATE_AN_ISSUE) so the
  // model calls composio_execute({ slug }) with exactly what it discovered.
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  toolkit?: string;
}

function toolkitOf(raw: unknown): string | undefined {
  const tk = (raw as { toolkit?: unknown }).toolkit;
  if (typeof tk === "string") return tk;
  if (tk && typeof tk === "object") {
    const slug = (tk as { slug?: unknown }).slug;
    if (typeof slug === "string") return slug;
  }
  return undefined;
}

export interface ComposioConnection {
  id: string;
  toolkit: string;
  status: string;
}

// The user's connected accounts. Used both for the status endpoint and to derive
// the default tool scope when no COMPOSIO_TOOLKITS allow-list is set.
export async function listComposioConnections(userId?: string): Promise<ComposioConnection[]> {
  if (!composioEnabled()) return [];
  const res = (await client().connectedAccounts.list({
    userIds: [userId ?? DEFAULT_USER_ID],
  })) as unknown as { items?: unknown[] } | unknown[];
  const items: unknown[] = Array.isArray(res) ? res : (res?.items ?? []);
  return items.map((it) => {
    const o = it as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      toolkit: (toolkitOf(o) ?? (o.toolkitSlug as string) ?? "unknown").toString(),
      status: String(o.status ?? "unknown"),
    };
  });
}

// List the Composio tools an agent may use, as MCP-ready defs. Scope resolution:
//   1. explicit opts.toolkits, else the COMPOSIO_TOOLKITS allow-list;
//   2. if neither and no search term, fall back to the toolkits the user has
//      actually connected (so an empty allow-list = "everything I connected");
//   3. a search term alone is honored (fuzzy discovery across the catalog).
// We never dump the entire Composio catalog unscoped.
export async function listComposioTools(opts?: {
  toolkits?: string[];
  search?: string;
  limit?: number;
  userId?: string;
}): Promise<ComposioToolDef[]> {
  if (!composioEnabled()) return [];
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const search = opts?.search?.trim();

  let toolkits = (opts?.toolkits?.length ? opts.toolkits : CONFIGURED_TOOLKITS)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (!toolkits.length && !search) {
    const conns = await listComposioConnections(opts?.userId);
    toolkits = Array.from(
      new Set(
        conns
          .map((c) => c.toolkit.toUpperCase())
          .filter((t) => t && t !== "UNKNOWN"),
      ),
    );
  }

  let query: Record<string, unknown>;
  if (toolkits.length) query = { toolkits, limit, ...(search ? { search } : {}) };
  else if (search) query = { search };
  else return [];

  const raw = (await client().tools.getRawComposioTools(query as never)) as unknown;
  const list: unknown[] = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] })?.items ?? []);
  return list.map((t) => {
    const o = t as Record<string, unknown>;
    return {
      name: String(o.slug ?? o.name ?? ""),
      description: String(o.description ?? o.name ?? o.slug ?? ""),
      inputSchema:
        (o.inputParameters as Record<string, unknown>) ?? { type: "object", properties: {} },
      toolkit: toolkitOf(o),
    };
  });
}

export interface ComposioExecResult {
  successful: boolean;
  data: Record<string, unknown>;
  error: string | null;
}

// Execute one Composio tool for the workspace's connected user. Throws only on
// SDK/transport failure; a tool that ran but failed comes back with
// successful:false + error so the caller can surface it to the model.
export async function executeComposioTool(
  slug: string,
  args: Record<string, unknown>,
  userId?: string,
): Promise<ComposioExecResult> {
  const res = await client().tools.execute(slug, {
    userId: userId ?? DEFAULT_USER_ID,
    arguments: args ?? {},
    // Agents discover slugs dynamically and don't pin a toolkit version, so use
    // the latest instead of erroring with "toolkit version not specified".
    dangerouslySkipVersionCheck: true,
  });
  return {
    successful: Boolean(res.successful),
    data: (res.data as Record<string, unknown>) ?? {},
    error: res.error ?? null,
  };
}

// Read-only heuristic for COMPOSIO_APPROVAL=writes. Composio slugs are verb-typed
// (GITHUB_LIST_REPOS, GMAIL_SEND_EMAIL); GET/LIST/SEARCH-style verbs are treated
// as read-only and auto-run, everything else needs approval. Conservative: an
// unrecognized verb is treated as a write (gated).
const READ_VERB_RE =
  /_(GET|LIST|SEARCH|FETCH|READ|FIND|RETRIEVE|CHECK|COUNT|LOOKUP|VIEW|DOWNLOAD|EXPORT)(_|$)/;

export function composioSlugIsReadOnly(slug: string): boolean {
  return READ_VERB_RE.test((slug ?? "").toUpperCase());
}

// Whether a composio_execute for this slug must go through the approval gate,
// per COMPOSIO_APPROVAL. Consulted by the executor.
export function composioNeedsApproval(slug: string): boolean {
  const policy = composioApprovalPolicy();
  if (policy === "off") return false;
  if (policy === "all") return true;
  return !composioSlugIsReadOnly(slug);
}
