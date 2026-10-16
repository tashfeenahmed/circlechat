// Per-account login-failure window, beside the per-IP limiter.
//
// /auth/login runs behind `rateLimit: { max: 5, timeWindow: "15 minutes" }`,
// which is keyed by CLIENT IP. That stops one attacker at one keyboard and
// nothing else: a guesser with a botnet (or just a mobile proxy plan, ~1 USD
// per 1000 IPs) sprays ONE account from a fresh IP per attempt and never trips
// the bucket, while the same 5-per-15-min budget still locks out a whole
// office NAT after one forgetful colleague. Slack, GitHub and Google all
// enforce the second axis too: N failures per ACCOUNT regardless of source.
// Same fix shipped this month for TikTokAgent (#78) and MarketingAgent (#528).
//
// Enumeration safety: failures are counted for UNKNOWN emails exactly the
// same way, and a locked-out unknown email gets the same 429 — the response
// never reveals whether the address exists.
//
// The state is per-process (a plain Map), which is the same scope
// @fastify/rate-limit's default store uses; a shared-Redis store can replace
// `store` later without touching call sites.

export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface FailureEntry {
  count: number;
  firstAtMs: number;
}

export interface Verdict {
  allowed: boolean;
  // Seconds until the window would let another attempt through (only
  // meaningful when allowed === false).
  retryAfterSeconds: number;
}

export type FailureStore = Map<string, FailureEntry>;

// Normalise so John@Example.com and john@example.com share a bucket (login is
// case-insensitive on email — verifyPassword compares the same stored hash).
export function loginThrottleKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Should this attempt proceed? Pure: takes the store + a clock, mutates
 * nothing. A window that has expired counts as zero failures.
 */
export function checkLoginAllowed(
  store: FailureStore,
  key: string,
  nowMs: number,
): Verdict {
  const entry = store.get(key);
  if (!entry || nowMs - entry.firstAtMs > LOGIN_WINDOW_MS) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= LOGIN_MAX_FAILURES) {
    const waitMs = entry.firstAtMs + LOGIN_WINDOW_MS - nowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Record a failed attempt. The window starts at the FIRST failure. */
export function recordLoginFailure(
  store: FailureStore,
  key: string,
  nowMs: number,
): void {
  const entry = store.get(key);
  if (!entry || nowMs - entry.firstAtMs > LOGIN_WINDOW_MS) {
    store.set(key, { count: 1, firstAtMs: nowMs });
    return;
  }
  entry.count += 1;
}

/** A successful login clears the slate — lockout is for guessers, not users. */
export function clearLoginFailures(store: FailureStore, key: string): void {
  store.delete(key);
}

// Bound memory on a busy instance: keys are only created by login attempts,
// but a spray of unique emails could still grow the Map. Prune expired
// entries whenever the store crosses this size.
const PRUNE_THRESHOLD = 10_000;

export const loginFailures: FailureStore = new Map();

export function noteLoginFailure(key: string, nowMs: number = Date.now()): void {
  if (loginFailures.size > PRUNE_THRESHOLD) {
    for (const [k, v] of loginFailures) {
      if (nowMs - v.firstAtMs > LOGIN_WINDOW_MS) loginFailures.delete(k);
    }
  }
  recordLoginFailure(loginFailures, key, nowMs);
}
