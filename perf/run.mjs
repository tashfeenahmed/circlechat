#!/usr/bin/env node
// CircleChat performance harness — orchestrator.
//
//   node run.mjs [stages...] [flags]
//
// stages : any of  bundle  lighthouse  backend  wsload   (default: all)
// flags  : --update-baseline   write this run's metrics into baseline.json
//          --strict            exit 1 if a `gate` metric REGRESSED (default: report-only, exit 0)
//          --base-url <url>    backend/wsload target (default $PERF_BASE_URL or http://localhost:8080)
//
// Output: prints a markdown report, writes results.json + report.md next to this
// file, and appends the report to $GITHUB_STEP_SUMMARY when set. Compares every
// metric to perf/baseline.json (regression-vs-baseline, per §16).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadJSON, saveJSON } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALL = ["bundle", "lighthouse", "backend", "wsload"];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const baseUrlIdx = argv.indexOf("--base-url");
if (baseUrlIdx !== -1 && argv[baseUrlIdx + 1]) process.env.PERF_BASE_URL = argv[baseUrlIdx + 1];
let stages = argv.filter((a) => ALL.includes(a));
if (!stages.length) stages = ALL;

const RUNNERS = {
  bundle: () => import("./stages/bundle.mjs").then((m) => m.runBundle()),
  lighthouse: () => import("./stages/lighthouse.mjs").then((m) => m.runLighthouse()),
  backend: () => import("./stages/backend.mjs").then((m) => m.runBackend()),
  wsload: () => import("./stages/wsload.mjs").then((m) => m.runWsload()),
};

function statusFor(name, val, def, baseVal) {
  if (!def) return { regressed: false, label: "info" };
  let label = "ok";
  let regressed = false;
  if (baseVal === null || baseVal === undefined) {
    label = "new";
  } else if (baseVal !== 0) {
    const deltaPct = ((val - baseVal) / Math.abs(baseVal)) * 100;
    const worse = def.lowerIsBetter ? deltaPct > 0 : deltaPct < 0;
    const mag = Math.abs(deltaPct);
    if (worse && mag > def.regressionPct) {
      label = "REGRESSED";
      regressed = true;
    } else if (!worse && mag > 1) {
      label = "improved";
    }
  }
  return { regressed, label };
}

function deltaStr(val, baseVal) {
  if (baseVal === null || baseVal === undefined || baseVal === 0) return "—";
  const d = ((val - baseVal) / Math.abs(baseVal)) * 100;
  const s = d >= 0 ? "+" : "";
  return `${s}${d.toFixed(1)}%`;
}

function budgetStr(val, def) {
  if (!def) return "—";
  const ok = def.lowerIsBetter ? val <= def.budget : val >= def.budget;
  return `${def.budget}${def.unit || ""} ${ok ? "✅" : "⚠️"}`;
}

async function main() {
  const budgets = (await loadJSON(join(HERE, "budgets.json"), { metrics: {} })).metrics;
  const baseline = await loadJSON(join(HERE, "baseline.json"), { metrics: {} });
  const baseMetrics = baseline.metrics || {};

  const metrics = {};
  const notes = [];
  for (const stage of stages) {
    process.stderr.write(`▶ ${stage}…\n`);
    try {
      const out = await RUNNERS[stage]();
      Object.assign(metrics, out.metrics || {});
      (out.notes || []).forEach((n) => notes.push(n));
    } catch (e) {
      notes.push(`${stage}: ERROR — ${e?.message || e}`);
    }
  }

  // Build report.
  const rows = [];
  let regressions = 0;
  const names = Object.keys(metrics).sort();
  for (const name of names) {
    const val = metrics[name];
    const def = budgets[name];
    const baseVal = baseMetrics[name] ?? null;
    const st = statusFor(name, val, def, baseVal);
    if (st.regressed && def?.gate) regressions++;
    rows.push({
      label: def?.label || name,
      val: `${val}${def?.unit || ""}`,
      budget: budgetStr(val, def),
      base: baseVal === null || baseVal === undefined ? "—" : `${baseVal}${def?.unit || ""}`,
      delta: deltaStr(val, baseVal),
      status: st.label,
      gate: def?.gate ? "🔒" : "",
    });
  }

  const ts = new Date().toISOString();
  let md = `## ⏱️ Performance report\n\n`;
  md += `_${ts} · stages: ${stages.join(", ")} · baseline: ${baseline.updatedAt || "none"}_\n\n`;
  if (rows.length) {
    md += `| Metric | Value | Budget | Baseline | Δ | Status |\n|---|--:|--:|--:|--:|:--|\n`;
    for (const r of rows) {
      md += `| ${r.gate} ${r.label} | ${r.val} | ${r.budget} | ${r.base} | ${r.delta} | ${r.status} |\n`;
    }
  } else {
    md += `_No metrics collected._\n`;
  }
  md += `\n${regressions ? `**⚠️ ${regressions} gated metric(s) REGRESSED vs baseline.**` : `No gated regressions vs baseline.`}\n`;
  if (notes.length) md += `\n<details><summary>Run notes</summary>\n\n${notes.map((n) => `- ${n}`).join("\n")}\n\n</details>\n`;
  md += `\n🔒 = would block in \`--strict\` mode. Report-only otherwise.\n`;

  console.log("\n" + md);
  await saveJSON(join(HERE, "results.json"), { ts, stages, metrics, notes });
  const { writeFile, appendFile } = await import("node:fs/promises");
  await writeFile(join(HERE, "report.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);

  if (flags.has("--update-baseline")) {
    const next = { updatedAt: ts, metrics };
    await saveJSON(join(HERE, "baseline.json"), next);
    process.stderr.write(`✓ baseline updated (${Object.keys(metrics).length} metrics)\n`);
  }

  process.exit(flags.has("--strict") && regressions ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(0); // report-only: never break the build on harness error
});
