import { describe, expect, it } from "vitest";

import {
  checkLoginAllowed,
  clearLoginFailures,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  loginThrottleKey,
  recordLoginFailure,
} from "../lib/login-throttle.js";

// The per-IP limiter on /auth/login (5 per 15 min) is invisible to a guesser
// that rotates source IPs. These pin the per-account axis added beside it —
// same fix shipped for TikTokAgent (#78) and MarketingAgent (#528).

const T0 = 1_780_000_000_000;
const key = "victim@example.com";

function spray(store: Map<string, any>, n: number, at = T0, which = key) {
  for (let i = 0; i < n; i++) recordLoginFailure(store, which, at);
}

describe("login throttle key", () => {
  it("normalises case and whitespace so one account has one bucket", () => {
    expect(loginThrottleKey("  John@Example.COM ")).toEqual(loginThrottleKey("john@example.com"));
  });
});

describe("per-account failure window", () => {
  it("allows up to LOGIN_MAX_FAILURES failures, then blocks", () => {
    const store = new Map();
    spray(store, LOGIN_MAX_FAILURES - 1);
    expect(checkLoginAllowed(store, key, T0).allowed).toBe(true);
    recordLoginFailure(store, key, T0);
    const v = checkLoginAllowed(store, key, T0);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("blocks regardless of source IP — the store never sees an IP", () => {
    // Structural pin: the API surface takes only (store, key, now). If anyone
    // reintroduces IP-keyed state here, this signature test still passes but
    // the route review note in the PR explains why per-IP is insufficient.
    const store = new Map();
    spray(store, LOGIN_MAX_FAILURES);
    for (let i = 0; i < 50; i++) {
      expect(checkLoginAllowed(store, key, T0).allowed).toBe(false);
    }
  });

  it("the window expires: after LOGIN_WINDOW_MS attempts are allowed again", () => {
    const store = new Map();
    spray(store, LOGIN_MAX_FAILURES);
    expect(checkLoginAllowed(store, key, T0).allowed).toBe(false);
    expect(checkLoginAllowed(store, key, T0 + LOGIN_WINDOW_MS + 1).allowed).toBe(true);
  });

  it("a failure after expiry starts a FRESH window, not a continuation", () => {
    const store = new Map();
    spray(store, LOGIN_MAX_FAILURES);
    const late = T0 + LOGIN_WINDOW_MS + 1_000;
    recordLoginFailure(store, key, late);
    const v = checkLoginAllowed(store, key, late);
    // 9 more failures still fit in the new window.
    expect(v.allowed).toBe(true);
    spray(store, LOGIN_MAX_FAILURES - 1, late);
    expect(checkLoginAllowed(store, key, late).allowed).toBe(false);
  });

  it("a successful login clears the failures for that address only", () => {
    const store = new Map();
    spray(store, LOGIN_MAX_FAILURES);
    const other = "other@example.com";
    spray(store, LOGIN_MAX_FAILURES - 1, T0, other);
    clearLoginFailures(store, key);
    expect(checkLoginAllowed(store, key, T0).allowed).toBe(true);
    // The other account's count is untouched (no global clear).
    recordLoginFailure(store, other, T0);
    expect(checkLoginAllowed(store, other, T0).allowed).toBe(false);
  });

  it("retry_after counts down with the clock", () => {
    const store = new Map();
    spray(store, LOGIN_MAX_FAILURES);
    const half = T0 + Math.floor(LOGIN_WINDOW_MS / 2);
    const v = checkLoginAllowed(store, key, half);
    expect(v.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 2000);
    expect(v.retryAfterSeconds).toBeGreaterThan(0);
  });
});
