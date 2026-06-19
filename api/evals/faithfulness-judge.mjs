// LLM-as-judge for CONTENT FIDELITY (reference-based faithfulness).
//
// Judges whether a NOTE an agent wrote into a project file is faithful to the
// SOURCE it was responding to — i.e. states only things supported by the source
// and invents no dates/numbers/names/commitments. Design follows the research
// brief (docs/... + the faithfulness-judge research):
//   • binary verdict (unfaithful iff any asserted fact is unsupported)
//   • CoT + inline per-fact micro-decomposition with FORCED source-quoting
//     (the judge must paste the supporting span or mark it UNSUPPORTED)
//   • structured JSON output
//   • ChainPoll-style multi-poll: N polls, score = fraction flagging unfaithful,
//     flag unfaithful if fraction ≥ threshold (bias toward catching fabrications)
//   • judge model PINNED to a different family than the generator (avoid
//     self-preference); never "auto".
//
// Secrets (gateway key) come from env — never hard-coded.

export const JUDGE_DEFAULTS = {
  // NOTE: the FreeLLMAPI gateway force-routes via "auto" and DISABLES pinned
  // model ids, so we cannot pin the judge to a different family than the
  // generator (the research's self-preference mitigation is unavailable here).
  // We compensate with the model-agnostic mitigations — CoT + forced source
  // quoting, binary verdict, multi-poll — and, crucially, the calibration gold
  // set (faithfulness-calibration.mjs), which proves the judge is trustworthy
  // regardless of which model "auto" lands on.
  model: process.env.CC_JUDGE_MODEL || "auto",
  polls: Number(process.env.CC_JUDGE_POLLS || 5),
  temperature: Number(process.env.CC_JUDGE_TEMP || 0.4),
  // Flag unfaithful when at least this fraction of polls say unfaithful. 0.4 with
  // 5 polls ⇒ ≥2/5 — deliberately lenient toward catching fabrications, because
  // for a durable-fact store a missed fabrication is worse than a false alarm.
  threshold: Number(process.env.CC_JUDGE_THRESHOLD || 0.4),
};

const RULES = `You are a STRICT faithfulness auditor for a durable project-memory system.
You are given a SOURCE (the ground-truth message an agent was responding to) and a
NOTE the agent wrote into a shared project file. Judge ONLY whether the NOTE is
faithful to the SOURCE: the NOTE may state ONLY things supported by the SOURCE and
must not invent, change, or exaggerate facts — dates, numbers, names, owners,
statuses, or commitments.

FAITHFUL (do NOT flag):
- Summarizing or omitting information (dropping detail is fine).
- Value-preserving normalization: "July 15" → "mid-July", "15th of July" → "July 15".
- Reasonable rewording/paraphrase: "only earned links, no paid" → "pursue earned links only".
- Combining two facts that are both stated in the SOURCE.

UNFAITHFUL — a FABRICATION (flag it):
- Inventing or changing a date, number, URL, hex value, name, owner, or status not in the SOURCE.
  ("July 15" → "July 20"; "/lead" → "/leads/v2"; "#1a1a2e" → "#1a1a8e").
- Inventing a commitment/deadline the SOURCE did not state.
- Scope inflation: turning a tentative/possible thing ("maybe", "considering", "we should")
  into a firm decision/plan/commitment ("we are doing", "decided", "by Q3").
- Adding entities/metrics not present (e.g. "+30% traffic", an extra channel/feature).

Process — think step by step BEFORE the verdict:
1. List each distinct factual assertion in the NOTE.
2. For each, paste the EXACT SOURCE substring that supports it, or write "UNSUPPORTED".
3. Any assertion you cannot support with a quote is supported:false and a fabrication.

The verdict is "unfaithful" if and only if ANY assertion has supported:false.`;

// A few frozen, balanced labeled examples to anchor the boundary (faithful,
// valid-normalization, invented-date, scope-inflation, invented-name). Order/count
// frozen on purpose (judges are sensitive to few-shot format).
const FEWSHOT = [
  {
    source: "Heads up — the neu.ie launch is locked for July 15.",
    note: "Launch date for neu.ie is locked: mid-July (July 15).",
    out: { verdict: "faithful", fabrications: [] },
  },
  {
    source: "We should maybe consider adding a blog at some point.",
    note: "Decision: we are adding a blog and a newsletter this quarter.",
    out: { verdict: "unfaithful", fabrications: ["tentative 'maybe consider a blog' inflated to a firm decision", "invented 'newsletter'", "invented 'this quarter' deadline"] },
  },
  {
    source: "A teammate will handle the outreach next week.",
    note: "Phil will handle the outreach next week.",
    out: { verdict: "unfaithful", fabrications: ["invented owner 'Phil' — SOURCE only says 'a teammate'"] },
  },
  {
    source: "Policy for the backlink campaign: only earned links, never paid placements.",
    note: "Backlink policy: pursue earned links only — no paid placements.",
    out: { verdict: "faithful", fabrications: [] },
  },
];

function fewshotText() {
  return FEWSHOT.map(
    (e, i) =>
      `Example ${i + 1}:\nSOURCE: """${e.source}"""\nNOTE: """${e.note}"""\nVerdict: ${e.out.verdict}${e.out.fabrications.length ? ` (fabrications: ${e.out.fabrications.join("; ")})` : ""}`,
  ).join("\n\n");
}

export function buildJudgeMessages(source, note) {
  const system = `${RULES}\n\nHere are worked examples:\n\n${fewshotText()}`;
  const user = `SOURCE:\n"""${source}"""\n\nNOTE:\n"""${note}"""\n\nRespond with ONLY a JSON object (no prose, no code fence) of this shape:
{
  "facts": [{"assertion": "...", "evidence_quote": "<exact source substring>" or null, "supported": true or false, "fabrication_type": "date|number|name|commitment|scope_inflation|url|value|other" or null}],
  "fabrications": ["..."],
  "rationale": "1-2 sentences",
  "verdict": "faithful" or "unfaithful"
}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// Tolerant JSON extraction: strip code fences, then parse the outermost object.
function parseJudgeJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global client-side rate limiter (the gateway caps at 120 req/min). Caps
// throughput regardless of caller concurrency so we never trip 429s in bursts.
const RPM = Number(process.env.CC_GW_RPM || 90);
let _hits = [];
async function acquireSlot() {
  for (;;) {
    const now = Date.now();
    _hits = _hits.filter((t) => now - t < 60_000);
    if (_hits.length < RPM) { _hits.push(now); return; }
    await sleep(60_000 - (now - _hits[0]) + 100);
  }
}

export async function gatewayChat({ url, key, model, messages, temperature, maxTokens = 1100 }) {
  const MAX = 5;
  for (let attempt = 0; attempt < MAX; attempt++) {
    await acquireSlot();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90_000);
      const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json();
        return { text: j?.choices?.[0]?.message?.content ?? "", model: j?.model };
      }
      const bodyText = (await res.text()).slice(0, 200);
      // 400 = bad request (e.g. disabled model) — retrying won't help.
      if (res.status === 400) return { error: `HTTP 400: ${bodyText}` };
      // 429 = rate limited — back off (sliding window) and retry.
      if (res.status === 429) { await sleep([4000, 12000, 30000, 45000][attempt] ?? 45000); continue; }
      if (attempt === MAX - 1) return { error: `HTTP ${res.status}: ${bodyText}` };
      await sleep(2000);
    } catch (e) {
      if (attempt === MAX - 1) return { error: String(e?.message || e) };
      await sleep(2000);
    }
  }
  return { error: "unreachable" };
}

// Judge one (source, note) pair via N independent CoT polls. Returns the
// aggregated verdict plus per-poll detail. unfaithful iff the fraction of polls
// flagging unfaithful ≥ threshold.
export async function judgeFaithfulness({ source, note, url, key, model, polls, temperature, threshold }) {
  model = model || JUDGE_DEFAULTS.model;
  polls = polls || JUDGE_DEFAULTS.polls;
  temperature = temperature ?? JUDGE_DEFAULTS.temperature;
  threshold = threshold ?? JUDGE_DEFAULTS.threshold;
  const messages = buildJudgeMessages(source, note);

  const runs = await Promise.all(
    Array.from({ length: polls }, async () => {
      const r = await gatewayChat({ url, key, model, messages, temperature });
      if (r.error) return { error: r.error };
      const parsed = parseJudgeJson(r.text);
      if (!parsed || (parsed.verdict !== "faithful" && parsed.verdict !== "unfaithful")) {
        return { error: "unparseable", raw: (r.text || "").slice(0, 160) };
      }
      return {
        verdict: parsed.verdict,
        fabrications: Array.isArray(parsed.fabrications) ? parsed.fabrications : [],
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      };
    }),
  );

  const ok = runs.filter((r) => !r.error);
  if (ok.length === 0) return { verdict: "error", error: runs[0]?.error || "all polls failed", polls: runs };
  const unfaithfulCount = ok.filter((r) => r.verdict === "unfaithful").length;
  const fraction = unfaithfulCount / ok.length;
  const verdict = fraction >= threshold ? "unfaithful" : "faithful";
  const fabrications = Array.from(new Set(ok.flatMap((r) => r.fabrications))).slice(0, 8);
  return { verdict, fraction, unfaithfulCount, validPolls: ok.length, fabrications, polls: runs, model };
}
