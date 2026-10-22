// What the search panel should render, decided by a pure function so the
// stale-results rule is unit-testable without a DOM.
//
// The bug this encodes: the panel used to render whatever `matches` happened
// to hold. On a failed request (network blip, expired session) the fetch
// swallowed the error and kept the PREVIOUS query's rows on screen — the
// panel showed results for "deploy" while the input said "release", and
// clicking one jumped to the wrong message entirely. Equally, while a request
// for a NEW needle was still in flight, the old needle's rows stayed listed.
// A search must only ever show rows that belong to the query on screen.

export type PanelState =
  | { kind: "idle" } // panel closed
  | { kind: "too_short" } // query shorter than MIN_LEN
  | { kind: "loading" } // request for the current needle in flight
  | { kind: "error" } // last request for THIS needle failed
  | { kind: "empty" } // no matches for the current needle
  | { kind: "results" }; // rows belonging to the current needle

export interface PanelInput {
  open: boolean;
  needle: string;
  minLength: number;
  loading: boolean;
  /** The needle the currently-held rows belong to, or null when none. */
  resultNeedle: string | null;
  matchCount: number;
  /** The needle whose last request failed, or null when the last one worked. */
  failedNeedle: string | null;
}

export function searchPanelState(i: PanelInput): PanelState {
  if (!i.open) return { kind: "idle" };
  if (i.needle.length < i.minLength) return { kind: "too_short" };
  // A failure for the current needle wins over any rows we still hold.
  if (i.failedNeedle === i.needle) return { kind: "error" };
  // Rows only count when they were fetched for THIS needle.
  if (i.resultNeedle === i.needle) {
    return i.matchCount > 0 ? { kind: "results" } : { kind: "empty" };
  }
  return i.loading ? { kind: "loading" } : { kind: "empty" };
}
