// Bundle-size stage: measures the gzipped weight of the INITIAL client payload
// (the entry script + every js/css the browser preloads on first paint), parsed
// straight out of the built dist/index.html. Lazy/route-split chunks are not
// counted toward the initial budget but are reported as a total for context.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gzipKB, round } from "../lib/util.mjs";

const WEB_DIST = new URL("../../web/dist/", import.meta.url).pathname;

async function gzipOf(relPath) {
  const buf = await readFile(join(WEB_DIST, relPath.replace(/^\//, "")));
  return gzipKB(buf);
}

// Every local .js/.css referenced by a src= or href= attribute in index.html —
// i.e. the entry chunk, its stylesheets, and modulepreloaded chunks. Order- and
// attribute-agnostic (the previous hand-rolled tag regex missed the entry).
function initialRefs(html) {
  const refs = new Set();
  const re = /(?:src|href)="(\/[^"?]+\.(?:js|css))(?:\?[^"]*)?"/g;
  let m;
  while ((m = re.exec(html))) refs.add(m[1]);
  return [...refs];
}

async function walkAssets(dir, base = "") {
  const out = [];
  for (const e of await readdir(join(WEB_DIST, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = join(base, e.name);
    if (e.isDirectory()) out.push(...(await walkAssets(join(dir, e.name), rel)));
    else if (e.name.endsWith(".js") || e.name.endsWith(".css")) out.push(rel);
  }
  return out;
}

export async function runBundle() {
  const metrics = {};
  const notes = [];
  let indexHtml;
  try {
    indexHtml = await readFile(join(WEB_DIST, "index.html"), "utf8");
  } catch {
    return { metrics, notes: ["bundle: SKIPPED — web/dist/index.html not found (run `npm --prefix web run build` first)"] };
  }

  const refs = initialRefs(indexHtml);
  let initialKB = 0;
  for (const ref of refs) {
    try {
      initialKB += await gzipOf(ref);
    } catch {
      notes.push(`bundle: could not read referenced asset ${ref}`);
    }
  }
  metrics.client_bundle_gzip_kb = round(initialKB, 1);
  notes.push(`bundle: initial payload = ${refs.length} asset(s): ${refs.join(", ")}`);

  // Informational: total gzipped js/css shipped (incl. lazy/route-split chunks).
  let totalKB = 0;
  for (const rel of await walkAssets("")) {
    try {
      totalKB += await gzipOf(rel);
    } catch {
      /* informational only */
    }
  }
  if (totalKB) metrics.client_total_gzip_kb_info = round(totalKB, 1);

  return { metrics, notes };
}
