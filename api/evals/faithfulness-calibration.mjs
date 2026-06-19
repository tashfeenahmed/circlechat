// Meta-eval: is the faithfulness JUDGE itself trustworthy?
//
// Runs the judge over a balanced GOLD SET of hand-labeled (source, note) pairs —
// seeded with the target failure modes (invented date/number/name/url/value,
// unstated commitment, scope inflation, status inflation) AND tricky faithful
// negatives we must NOT flag (normalization, summarization, paraphrase, correctly
// named owner) — then reports accuracy, unfaithful-class precision/recall/F1, and
// Cohen's κ. Per the research: never trust the judge until it clears the gold set.
//
//   CC_GW_URL=… CC_GW_KEY=… CC_JUDGE_MODEL=gemini-2.5-pro CC_JUDGE_POLLS=5 \
//     node api/evals/faithfulness-calibration.mjs

import { judgeFaithfulness, JUDGE_DEFAULTS } from "./faithfulness-judge.mjs";

const URL = (process.env.CC_GW_URL || "").replace(/\/$/, "");
const KEY = process.env.CC_GW_KEY || "";
const CONCURRENCY = Number(process.env.CC_EVAL_CONCURRENCY || 4);
if (!URL || !KEY) { console.error("Set CC_GW_URL and CC_GW_KEY."); process.exit(2); }

// label: "faithful" | "unfaithful" (unfaithful = positive class)
const GOLD = [
  // ── faithful: must NOT be flagged ──
  { id: "F exact restate (date)", label: "faithful", source: "Heads up — the neu.ie launch is locked for July 15.", note: "neu.ie launch date is locked: July 15." },
  { id: "F normalization July15→mid-July", label: "faithful", source: "The neu.ie launch is locked for July 15.", note: "Launch is locked for mid-July (the 15th)." },
  { id: "F paraphrase (policy)", label: "faithful", source: "Policy for the backlink campaign: only earned links, never paid placements.", note: "Backlink policy: pursue earned links only — no paid placements." },
  { id: "F summarize/omit detail", label: "faithful", source: "For neu.ie use plain HTML/CSS/JS, no build step, dark premium look, and ship to the sslip preview URL.", note: "neu.ie stack: plain HTML/CSS/JS, no build step." },
  { id: "F combine two stated facts", label: "faithful", source: "The contact form must POST to /lead. Also, the launch is July 15.", note: "Contact form posts to /lead; launch July 15." },
  { id: "F url preserved + reworded", label: "faithful", source: "Wire every CTA to https://api.neu.ie/lead — that's the lead endpoint.", note: "Lead endpoint for all CTAs: https://api.neu.ie/lead." },
  { id: "F tentative kept tentative", label: "faithful", source: "We might add a blog at some point, not sure yet.", note: "Possible future idea: a blog (not decided)." },
  { id: "F owner correctly named", label: "faithful", source: "Phil will handle the developer-community outreach.", note: "Owner for dev-community outreach: Phil." },

  // ── unfaithful: MUST be flagged ──
  { id: "U invented date", label: "unfaithful", source: "We'll launch neu.ie soon, date TBD.", note: "neu.ie launch date: July 15." },
  { id: "U wrong endpoint", label: "unfaithful", source: "The contact form must POST to /lead.", note: "Contact form must POST to /leads/v2." },
  { id: "U invented owner", label: "unfaithful", source: "A teammate will handle the outreach next week.", note: "Phil will handle the outreach next week." },
  { id: "U unstated commitment/deadline", label: "unfaithful", source: "We should consider a redesign at some point.", note: "Committed: full redesign delivered by Q3." },
  { id: "U scope inflation + invented feature", label: "unfaithful", source: "Maybe we add a blog someday.", note: "Decision: we are adding a blog and a newsletter this quarter." },
  { id: "U wrong hex value", label: "unfaithful", source: "Lock the dark indigo #1a1a2e palette as canonical.", note: "Canonical palette: dark indigo #1a1a8e." },
  { id: "U invented metric", label: "unfaithful", source: "We got accepted into the Futurepedia AI directory.", note: "Accepted into 5 AI directories; referral traffic up 30%." },
  { id: "U status inflation", label: "unfaithful", source: "The homepage draft is in review.", note: "The homepage is done and shipped to production." },
];

async function runPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

console.log(`Faithfulness judge calibration · judge=${JUDGE_DEFAULTS.model} · polls=${JUDGE_DEFAULTS.polls} · threshold=${JUDGE_DEFAULTS.threshold} · ${GOLD.length} gold items\n`);

const results = await runPool(GOLD, CONCURRENCY, async (item) => {
  const j = await judgeFaithfulness({ source: item.source, note: item.note, url: URL, key: KEY });
  return { item, j };
});

let TP = 0, FN = 0, FP = 0, TN = 0, errs = 0;
for (const { item, j } of results) {
  if (j.verdict === "error") { errs++; console.log(`⚠ ERR  ${item.id} — ${j.error}`); continue; }
  const goldUnf = item.label === "unfaithful";
  const judgeUnf = j.verdict === "unfaithful";
  if (goldUnf && judgeUnf) TP++;
  else if (goldUnf && !judgeUnf) FN++;
  else if (!goldUnf && judgeUnf) FP++;
  else TN++;
  const correct = goldUnf === judgeUnf;
  const tag = correct ? "✓" : "✗";
  const miss = !correct ? (goldUnf ? "  ← MISSED FABRICATION" : "  ← FALSE ALARM") : "";
  console.log(`${tag} gold=${item.label.padEnd(10)} judge=${j.verdict.padEnd(10)} [${j.unfaithfulCount}/${j.validPolls}] ${item.id}${miss}`);
  if (!correct && j.fabrications?.length) console.log(`        judge said: ${j.fabrications.slice(0, 3).join("; ")}`);
}

const N = TP + FN + FP + TN;
const acc = N ? (TP + TN) / N : 0;
const recall = TP + FN ? TP / (TP + FN) : 0;        // unfaithful-class recall (the dangerous one)
const precision = TP + FP ? TP / (TP + FP) : 0;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
const po = acc;
const pYes = (TP + FP) / N, pNo = (FN + TN) / N;
const gYes = (TP + FN) / N, gNo = (FP + TN) / N;
const pe = pYes * gYes + pNo * gNo;
const kappa = pe < 1 ? (po - pe) / (1 - pe) : 1;

const pct = (x) => `${Math.round(x * 100)}%`;
console.log(`\nConfusion (unfaithful = positive): TP=${TP} FN=${FN} FP=${FP} TN=${TN}${errs ? ` · errors=${errs}` : ""}`);
console.log(`Accuracy=${pct(acc)} · Unfaithful recall=${pct(recall)} · Unfaithful precision=${pct(precision)} · F1=${pct(f1)} · Cohen's κ=${kappa.toFixed(2)}`);
const verdict = kappa >= 0.6 && recall >= 0.8 ? "TRUSTWORTHY ✓ (κ≥0.6, recall≥80%)" : "NOT YET — tune rubric/model/threshold (need κ≥0.6 & unfaithful-recall≥80%)";
console.log(`Judge status: ${verdict}`);
