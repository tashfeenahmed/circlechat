// One place that turns an environment variable into a number.
//
// `Number(process.env.X ?? 900_000)` reads correctly and is wrong the moment
// the variable is DECLARED BUT EMPTY — which is exactly what compose.yml does
// for every tunable:
//
//     GOAL_PARK_AFTER_MS: ${GOAL_PARK_AFTER_MS:-}
//
// With nothing in the operator's `.env`, that puts an EMPTY STRING into the
// container's environment. `??` only falls back on null/undefined, so the
// empty string sails through, and `Number("")` is 0. Observed on live:
//
//   GOAL_PARK_AFTER_MS=""           → 0 → every goal auto-parked two minutes
//                                         after deploy, "nothing on it has
//                                         moved in 0+ days"
//   CC_SPECTATOR_DONE_WINDOW_MS=""  → 0 → the public board would show zero
//                                         Done cards
//   CC_SCHEDULED_SKIP_STREAK=""     → 0 → backoff from the first skip instead
//                                         of the third
//   CC_SCHEDULED_BACKOFF_CAP_MS=""  → 0 → backoff never escalates past one
//                                         interval
//   AMBIENT_HUMAN_ACTIVE_MS=""      → 0 → `if (HUMAN_ACTIVE_MS > 0)` silently
//                                         turns the check off
//
// The same trap sits behind `Number.isFinite(n)` guards that allow 0: an empty
// VERIFIER_PASS_THRESHOLD became a threshold of 0, which passes everything.
//
// So one rule, everywhere: unset, empty, whitespace, or not a finite number
// all mean "the operator did not set this" and get the default. A value
// outside [min, max] is a typo rather than a policy and gets the default too.
// An explicit "0" is still honoured wherever `min` allows it — that is how
// AMBIENT_HUMAN_ACTIVE_MS=0 disables its check.
//
// api/hermes-multi-bridge.mjs and lib/retention.ts already did this by hand;
// this is that rule, named, so no new call site has to remember it.

export interface EnvNumOptions {
  /** Smallest accepted value (inclusive). Default 0. */
  min?: number;
  /** Largest accepted value (inclusive). Default Infinity. */
  max?: number;
  /** Environment to read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Coerce an already-read raw value. Pure — the unit-testable core. */
export function coerceNum(
  raw: string | undefined | null,
  fallback: number,
  opts: Omit<EnvNumOptions, "env"> = {},
): number {
  if (raw == null || String(raw).trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  const { min = 0, max = Number.POSITIVE_INFINITY } = opts;
  if (v < min || v > max) return fallback;
  return v;
}

/** `coerceNum`, truncated toward zero. */
export function coerceInt(
  raw: string | undefined | null,
  fallback: number,
  opts: Omit<EnvNumOptions, "env"> = {},
): number {
  return Math.trunc(coerceNum(raw, fallback, opts));
}

/** The numeric value of an environment variable, or `fallback`. */
export function envNum(name: string, fallback: number, opts: EnvNumOptions = {}): number {
  const { env = process.env, ...rest } = opts;
  return coerceNum(env[name], fallback, rest);
}

/** `envNum`, truncated toward zero — for counts, batch sizes and streaks. */
export function envInt(name: string, fallback: number, opts: EnvNumOptions = {}): number {
  const { env = process.env, ...rest } = opts;
  return coerceInt(env[name], fallback, rest);
}
