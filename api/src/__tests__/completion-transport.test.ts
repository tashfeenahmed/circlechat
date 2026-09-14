import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chatJsonOutcome,
  chatOutcome,
  isTransportStatus,
  noteRouterRateLimit,
  parseRetryAfter,
  summariseRouterBody,
  type ChatTarget,
} from "../lib/completion.js";
import { countsAsPlanAttempt } from "../agents/goal-planner-worker.js";
import { decideOnRejudgeCap, tallyVerdictRows } from "../lib/task-verifier.js";

// LIVE FAILURE, 14 Sep 2026. The FreeLLMAPI router ran out of free Gemini
// quota and answered every planner call with
//   http_429 "All models exhausted: 3 routes checked (3 rate-limited or on
//             cooldown)… Soonest reset ~57m"
// The client treated that identically to a bad answer: it retried the pinned
// gemini-2.5-flash call on model=auto, the auto route replied
// `["deployment","publishing"]` to a task-plan prompt, and the planner recorded
// plan_generation_failed + incremented goals.plan_attempts. With
// GOAL_MAX_PLAN_ATTEMPTS=3 and a sweep every 3 minutes, one hour of quota
// outage permanently abandoned every open goal on the board.

const target: ChatTarget = { baseUrl: "http://gw/v1", apiKey: "k", model: "gemini-2.5-flash" };

function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

function okJson(content: string): Response {
  return res(200, JSON.stringify({ choices: [{ message: { content } }] }));
}

let fetchMock: ReturnType<typeof vi.fn>;
/** The `model` field of every request the client actually sent. */
const modelsCalled = (): string[] =>
  fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).model);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("57")).toBe(57_000);
    expect(parseRetryAfter("0")).toBe(0);
  });
  it("reads an HTTP-date, relative to now", () => {
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    expect(parseRetryAfter("Mon, 14 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
  });
  it("never goes negative on a date already past", () => {
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    expect(parseRetryAfter("Mon, 14 Sep 2026 11:59:00 GMT", now)).toBe(0);
  });
  it("is null when absent or unparseable", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("isTransportStatus", () => {
  it("counts rate limits, request timeouts, server errors and network failures", () => {
    for (const s of [0, 408, 425, 429, 500, 502, 503, 504]) expect(isTransportStatus(s)).toBe(true);
  });
  it("does NOT count a bad request or bad credentials — retrying those changes nothing", () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isTransportStatus(s)).toBe(false);
  });
});

describe("summariseRouterBody", () => {
  it("collapses the router's explanation to one line", () => {
    expect(summariseRouterBody("All models exhausted:\n  3 routes checked\n")).toBe(
      "All models exhausted: 3 routes checked",
    );
  });
  it("truncates", () => {
    expect(summariseRouterBody("x".repeat(500))).toHaveLength(241); // 240 + ellipsis
  });
});

describe("noteRouterRateLimit", () => {
  it("logs once per minute per model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = 1_000_000;
    expect(noteRouterRateLimit(target, 429, 3_420_000, "All models exhausted", t0)).toBe(true);
    expect(noteRouterRateLimit(target, 429, 3_420_000, "All models exhausted", t0 + 30_000)).toBe(false);
    // A different model on the same gateway is its own story.
    expect(noteRouterRateLimit({ ...target, model: "auto" }, 429, null, "", t0 + 30_000)).toBe(true);
    expect(noteRouterRateLimit(target, 429, 3_420_000, "All models exhausted", t0 + 61_000)).toBe(true);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain("router rate-limited (429)");
    expect(line).toContain("model=gemini-2.5-flash");
    expect(line).toContain("retry_after=3420s");
    expect(line).toContain("All models exhausted");
  });
});

describe("chatJsonOutcome — transport failures", () => {
  it("returns a typed transport failure on 429 and NEVER falls back to model=auto", async () => {
    fetchMock.mockResolvedValue(
      res(429, "All models exhausted: 3 routes checked. Soonest reset ~57m", { "retry-after": "0" }),
    );
    const r = await chatJsonOutcome([{ role: "user", content: "plan this" }], { target });
    expect(r.kind).toBe("transport");
    if (r.kind !== "transport") throw new Error("unreachable");
    expect(r.status).toBe(429);
    expect(r.retryAfterMs).toBe(0);
    expect(r.detail).toContain("Soonest reset ~57m");
    // Three in-call attempts, all on the PINNED model. The old client called
    // the `auto` route on failure, which answered ["deployment","publishing"].
    expect(modelsCalled()).toEqual(["gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.5-flash"]);
  });

  it("honours a Retry-After longer than the retry budget by giving up immediately", async () => {
    fetchMock.mockResolvedValue(res(429, "exhausted", { "retry-after": "3420" }));
    const r = await chatJsonOutcome([{ role: "user", content: "plan" }], { target });
    expect(r.kind).toBe("transport");
    if (r.kind !== "transport") throw new Error("unreachable");
    expect(r.retryAfterMs).toBe(3_420_000);
    // One attempt: we do not hold a worker job for 57 minutes, and we do not
    // hammer a router that just told us how long it needs.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx in-call and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(res(503, "upstream down"))
      .mockResolvedValueOnce(okJson('{"tasks":[{"key":"t1"}]}'));
    const r = await chatJsonOutcome<{ tasks: unknown[] }>([{ role: "user", content: "plan" }], { target });
    expect(r).toEqual({ kind: "ok", value: { tasks: [{ key: "t1" }] } });
    expect(modelsCalled()).toEqual(["gemini-2.5-flash", "gemini-2.5-flash"]);
  });

  it("treats a network error as transport, not as a bad answer", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce(okJson('{"ok":true}'));
    const r = await chatJsonOutcome([{ role: "user", content: "plan" }], { target });
    expect(r).toEqual({ kind: "ok", value: { ok: true } });
  });

  it("treats a 401 as invalid, not transport — retrying identically never fixes it", async () => {
    fetchMock.mockResolvedValue(res(401, "bad key"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await chatJsonOutcome([{ role: "user", content: "plan" }], { target });
    expect(r.kind).toBe("invalid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("chatJsonOutcome — genuine model answers", () => {
  it("never falls back to auto for a JSON call, even when the pinned model answers garbage", async () => {
    // A reply with no JSON at all: the model WAS reached, so this is the
    // caller's problem to count, and `auto` must not be asked to have a go.
    fetchMock.mockResolvedValue(okJson("I think we should probably start with discovery."));
    const r = await chatJsonOutcome([{ role: "user", content: "plan" }], {
      target,
      // Even an explicit opt-in is ignored for JSON calls.
      allowModelFallback: true,
    });
    expect(r.kind).toBe("invalid");
    // Two calls: the original plus the terser "JSON only" nudge — both pinned.
    expect(modelsCalled()).toEqual(["gemini-2.5-flash", "gemini-2.5-flash"]);
  });

  it("parses the nudged retry", async () => {
    fetchMock.mockResolvedValueOnce(okJson("no json here")).mockResolvedValueOnce(okJson('{"tasks":[]}'));
    const r = await chatJsonOutcome([{ role: "user", content: "plan" }], { target });
    expect(r).toEqual({ kind: "ok", value: { tasks: [] } });
  });

  it("does not launder a bad answer into a transport failure when the NUDGE hits the rate limit", async () => {
    fetchMock
      .mockResolvedValueOnce(okJson("thinking out loud, no json"))
      .mockResolvedValue(res(429, "exhausted", { "retry-after": "3420" }));
    const r = await chatJsonOutcome([{ role: "user", content: "plan" }], { target });
    // The model answered once and its answer was unusable — that is a real
    // outcome the planner should count, not a free pass.
    expect(r.kind).toBe("invalid");
  });

  it("is unconfigured when no target resolves", async () => {
    expect(await chatJsonOutcome([{ role: "user", content: "x" }], { target: null })).toEqual({
      kind: "unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("chatOutcome — free-text fallback is opt-in", () => {
  it("retries a pinned model's UNUSABLE answer on auto when the caller opts in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(res(200, JSON.stringify({ error: { message: "no choices" } })))
      .mockResolvedValueOnce(okJson("the updated whiteboard"));
    const r = await chatOutcome([{ role: "user", content: "summarise" }], { target, allowModelFallback: true });
    expect(r).toEqual({ kind: "ok", value: "the updated whiteboard" });
    expect(modelsCalled()).toEqual(["gemini-2.5-flash", "auto"]);
  });

  it("does NOT retry on auto without the opt-in", async () => {
    fetchMock.mockResolvedValue(res(200, JSON.stringify({ error: { message: "no choices" } })));
    const r = await chatOutcome([{ role: "user", content: "summarise" }], { target });
    expect(r.kind).toBe("invalid");
    expect(modelsCalled()).toEqual(["gemini-2.5-flash"]);
  });

  it("does NOT fall back to auto on a transport failure, opt-in or not", async () => {
    fetchMock.mockResolvedValue(res(429, "exhausted", { "retry-after": "3420" }));
    const r = await chatOutcome([{ role: "user", content: "summarise" }], { target, allowModelFallback: true });
    expect(r.kind).toBe("transport");
    expect(modelsCalled()).toEqual(["gemini-2.5-flash"]);
  });
});

describe("countsAsPlanAttempt", () => {
  it("does not spend an attempt on a gateway outage", () => {
    expect(countsAsPlanAttempt("planner_transport")).toBe(false);
    expect(countsAsPlanAttempt("planner_unconfigured")).toBe(false);
  });
  it("still does not spend one where there is nothing to retry", () => {
    expect(countsAsPlanAttempt("already_planned")).toBe(false);
    expect(countsAsPlanAttempt("goal_not_found")).toBe(false);
    expect(countsAsPlanAttempt("wrong_workspace")).toBe(false);
  });
  it("DOES spend one on a genuine model answer the schema or the gate rejected", () => {
    expect(countsAsPlanAttempt("plan_generation_failed")).toBe(true);
    expect(countsAsPlanAttempt("empty_plan")).toBe(true);
    expect(countsAsPlanAttempt("cyclic_plan")).toBe(true);
    expect(countsAsPlanAttempt("no_roster")).toBe(true);
  });
});

describe("re-judge cap ignores transport errors", () => {
  const SET = "set-abc";
  const row = (verdict: string, extra: Record<string, unknown> = {}) => ({
    verdict,
    rubricJson: { setKey: SET, ...extra },
  });

  it("does not let a rate-limited gateway eat the three judge slots", () => {
    const rows = [row("error", { transport: true }), row("error", { transport: true }), row("error", { transport: true })];
    expect(tallyVerdictRows(rows, SET)).toEqual({ total: 0, lastVerdict: null });
    expect(decideOnRejudgeCap(tallyVerdictRows(rows, SET), 3)).toEqual({ judge: true });
  });

  it("still counts real judge outages and real verdicts", () => {
    const rows = [row("error"), row("fail"), row("error", { transport: true }), row("pass")];
    // Three countable rows; the newest REAL verdict wins over the newer error.
    expect(tallyVerdictRows(rows, SET)).toEqual({ total: 3, lastVerdict: "fail" });
    expect(decideOnRejudgeCap({ total: 3, lastVerdict: "fail" }, 3)).toEqual({
      judge: false,
      outcome: "verification_failed",
    });
  });

  it("ignores rows belonging to a different artifact set", () => {
    const rows = [{ verdict: "fail", rubricJson: { setKey: "other" } }, row("pass")];
    expect(tallyVerdictRows(rows, SET)).toEqual({ total: 1, lastVerdict: "pass" });
  });
});
