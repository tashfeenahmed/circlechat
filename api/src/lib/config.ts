const required = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL", "postgres://postgres:circlechat@localhost:5432/circlechat"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  sessionSecret: required("SESSION_SECRET", "dev-secret-change-me-at-least-32-chars-long"),
  publicBaseUrl: required("PUBLIC_BASE_URL", "http://localhost:5173"),
  apiInternalUrl: process.env.API_INTERNAL_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  smtpUrl: process.env.SMTP_URL ?? "",
  // CORS compares origins, not full URLs (PUBLIC_BASE_URL may include a path
  // or a trailing slash in operator-managed deployments).
  publicOrigin: new URL(required("PUBLIC_BASE_URL", "http://localhost:5173")).origin,
} as const;

// ───────────────── approval policy (read at call time, so tests + hot env
// changes work) ─────────────────
//
// Anything here changes how much a human must be in the loop, so every
// default is the conservative one: cards expire (so nothing waits forever),
// denials are remembered (so agents can't re-ask), and nothing is
// auto-approved unless an operator lists it.

const num = (name: string, fallback: number, min = 0): number => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min ? v : fallback;
};

// Hours a pending approval may wait for a human before it is marked
// `expired`, the agent is woken with approval_response status "expired", and
// tasks blocked on it are released. 0 = never expire (the legacy behaviour).
// APPROVAL_DEFAULT_TTL is accepted as an alias.
export function approvalTtlHours(): number {
  if (process.env.APPROVAL_TTL_HOURS != null && process.env.APPROVAL_TTL_HOURS.trim() !== "") {
    return num("APPROVAL_TTL_HOURS", 72);
  }
  return num("APPROVAL_DEFAULT_TTL", 72);
}

// Days a denied (or expired) approval keeps refusing equivalent re-requests.
export function approvalDenialMemoryDays(): number {
  return num("APPROVAL_DENIAL_MEMORY_DAYS", 7);
}

// Comma-separated approval scopes that are auto-approved (with an audit row)
// for every agent in the deployment. Entries match an approval's scope
// exactly (case-insensitive) or by prefix with a trailing `*`
// (`tasks.*`, `risk:*`, `deploy*`). Credential requests are never
// auto-approved — approving them produces no secret. Empty by default.
export function autoApproveScopes(): string[] {
  return (process.env.AUTO_APPROVE_SCOPES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// How long the worker→api internal dispatch waits for the bridge to return an
// agent's reply. Must exceed the bridge's HERMES_TIMEOUT (seconds) or every
// long tool-using run dies as `dispatch_504` while Hermes is still working.
// Explicit CC_DISPATCH_TIMEOUT_MS wins; otherwise HERMES_TIMEOUT + 60 s.
export function dispatchTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const explicit = Number(env.CC_DISPATCH_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const hermesSec = Number(env.HERMES_TIMEOUT);
  return ((Number.isFinite(hermesSec) && hermesSec > 0 ? hermesSec : 480) + 60) * 1000;
}
