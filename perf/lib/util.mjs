// Small shared helpers for the perf harness. No external deps.
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

export async function loadJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function saveJSON(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + "\n");
}

export function gzipKB(buf) {
  return gzipSync(buf, { level: 9 }).length / 1024;
}

// Nearest-rank percentile over an array of numbers.
export function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function round(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll an async predicate until it returns truthy or the deadline passes.
export async function waitFor(fn, { timeoutMs = 60000, intervalMs = 1000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ""}`);
}
