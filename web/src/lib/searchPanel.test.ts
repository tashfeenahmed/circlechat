import { describe, it, expect } from "vitest";
import { searchPanelState } from "./searchPanel";

const base = {
  open: true,
  needle: "deploy",
  minLength: 2,
  loading: false,
  resultNeedle: "deploy" as string | null,
  matchCount: 3,
  failedNeedle: null as string | null,
};

describe("searchPanelState", () => {
  it("shows results only for the needle they were fetched for", () => {
    expect(searchPanelState(base)).toEqual({ kind: "results" });
    // rows belong to an older query while the new one is in flight → no stale rows
    expect(searchPanelState({ ...base, needle: "release", resultNeedle: "deploy", loading: true })).toEqual({
      kind: "loading",
    });
    // …and if the old request errored, the stale rows must not linger either
    expect(searchPanelState({ ...base, needle: "release", resultNeedle: "deploy", loading: false })).toEqual({
      kind: "empty",
    });
  });

  it("a failed request for the current needle shows the error, never stale rows", () => {
    expect(searchPanelState({ ...base, failedNeedle: "deploy" })).toEqual({ kind: "error" });
  });

  it("a failure for an OLD needle does not haunt the current one", () => {
    expect(searchPanelState({ ...base, failedNeedle: "older", resultNeedle: null, loading: true })).toEqual({
      kind: "loading",
    });
  });

  it("short queries and a closed panel win", () => {
    expect(searchPanelState({ ...base, needle: "d" })).toEqual({ kind: "too_short" });
    expect(searchPanelState({ ...base, open: false })).toEqual({ kind: "idle" });
  });

  it("zero matches for the current needle is empty, not results", () => {
    expect(searchPanelState({ ...base, matchCount: 0 })).toEqual({ kind: "empty" });
  });
});
