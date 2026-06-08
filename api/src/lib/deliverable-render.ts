// Execution check for the verification gate — renders a web deliverable in
// headless Chromium and reports what ACTUALLY loaded, so the LLM judge scores an
// observed final state instead of source that merely "looks complete". Closes
// the gap where a plausible-but-broken site passes the text-only judge.
//
// Reuses infra already on the box: Chromium (CHROMIUM_BIN, the same binary the
// agent-browser skill drives) and the local-disk artifact store. No new
// dependency, no Playwright. A single `chromium --headless --dump-dom`
// subprocess executes the page's JS and prints the post-JS DOM — exactly the
// observable we want, far simpler than driving the stateful agent-browser.
//
// Strictly best-effort and additive: every failure path returns null so the
// caller falls back to the text-only judge. The render can only ADD evidence;
// it never blocks a flip on its own.
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { liveArtifactRows } from "./task-artifacts.js";
import { readObject } from "./storage.js";
import type { TaskArtifact } from "../db/schema.js";

export type RenderObservation = {
  ok: boolean; // chromium produced a non-trivial DOM
  entry: string; // file that was rendered
  renderedTextLen: number; // visible text chars after JS (scripts/styles stripped)
  domBytes: number; // serialized DOM size
  consoleErrors: string[]; // best-effort: error lines parsed from chromium stderr
  note: string; // one-line human/judge summary
};

function chromiumBin(): string {
  return process.env.CHROMIUM_BIN || "/usr/bin/chromium";
}
function timeoutMs(): number {
  const n = Number(process.env.VERIFY_EXEC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

const MAX_DOM_BYTES = 256 * 1024; // cap captured stdout
const MAX_ASSET_BYTES = 5 * 1024 * 1024; // skip writing any single huge artifact
const MAX_FILES = 200;

// Run a command, capturing stdout/stderr/exit with a hard timeout (SIGKILL on
// overrun). The existing hermes helpers only keep stderr and reject on nonzero;
// the render needs stdout (the DOM) and must not throw on a nonzero exit.
function spawnCapture(
  cmd: string,
  args: string[],
  ms: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { env: process.env });
    } catch {
      resolve({ code: null, stdout: "", stderr: "spawn_failed", timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ms);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_DOM_BYTES) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 64 * 1024) stderr += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || "spawn_error", timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// Latest version per name, capped, with renderable assets first.
function pickFiles(rows: TaskArtifact[]): TaskArtifact[] {
  const byName = new Map<string, TaskArtifact>();
  for (const r of rows.sort((a, b) => b.version - a.version)) {
    if (!byName.has(r.name)) byName.set(r.name, r);
  }
  return Array.from(byName.values()).slice(0, MAX_FILES);
}

function chooseEntry(files: TaskArtifact[], entryName: string): string | null {
  const isHtml = (n: string) => /\.html?$/i.test(n);
  if (isHtml(entryName) && files.some((f) => f.name === entryName)) return entryName;
  const index = files.find((f) => /^index\.html?$/i.test(f.name));
  if (index) return index.name;
  const anyHtml = files.find((f) => isHtml(f.name));
  return anyHtml?.name ?? null;
}

function visibleTextLen(dom: string): number {
  return dom
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

// Extract GENUINE page errors from Chromium's stderr while dropping its internal
// C++ logging noise (GPU/process/sandbox spam like
// `[pid:tid:MMDD/...:ERROR:gpu/.../foo.cc:386] …`), which is unrelated to the
// deliverable and would otherwise be reported as false "console errors". In
// practice headless `--dump-dom` rarely surfaces page JS errors at all, so this
// is usually empty — the load + visible-text signals carry the weight. We only
// keep failed-resource loads and JS exceptions, never the engine's own logs.
function parseConsoleErrors(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split("\n")) {
    // Chrome-internal log line: [..:ERROR:some/path/file.cc:123] — skip.
    if (/:(ERROR|WARNING|INFO|VERBOSE)\d?:[^\]]*\.(cc|mm|h):\d+\]/.test(line)) continue;
    if (/\b(Uncaught|net::ERR_|SyntaxError|ReferenceError|TypeError)\b/.test(line)) {
      out.push(line.trim().slice(0, 200));
    }
  }
  return out.slice(0, 10);
}

// Reconstruct the task's deliverable files into a temp dir and render the entry
// HTML. Returns null when not applicable (no html, chromium absent/uninstalled,
// or any error) so the caller defers to the text-only judge.
export async function renderWebDeliverable(opts: {
  taskId: string;
  entryName: string;
}): Promise<RenderObservation | null> {
  const rows = await liveArtifactRows(opts.taskId).catch(() => [] as TaskArtifact[]);
  if (!rows.length) return null;
  const files = pickFiles(rows);
  const entry = chooseEntry(files, opts.entryName);
  if (!entry) return null; // nothing renderable

  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(join(tmpdir(), "ccrender-"));
    const root = dir;
    // Materialize files under their (sanitized-at-ingest, flat) names. Guard the
    // join anyway so a crafted name can never escape the temp dir.
    for (const f of files) {
      if (f.size > MAX_ASSET_BYTES) continue;
      const abs = normalize(join(root, f.name));
      if (!abs.startsWith(root + sep)) continue;
      const buf = await readObject(f.storageKey);
      if (!buf) continue;
      await fs.mkdir(join(abs, ".."), { recursive: true }).catch(() => {});
      await fs.writeFile(abs, buf).catch(() => {});
    }

    const ms = timeoutMs();
    const res = await spawnCapture(
      chromiumBin(),
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        `--virtual-time-budget=${Math.max(1000, ms - 1500)}`,
        "--dump-dom",
        `file://${join(root, entry)}`,
      ],
      ms,
    );

    // Chromium missing/uninstalled → null (defer to text judge), don't penalize.
    if (res.stderr === "spawn_failed" || res.stderr === "spawn_error" || res.code === null) {
      if (/ENOENT|spawn_failed|spawn_error/i.test(res.stderr)) return null;
    }

    const dom = res.stdout || "";
    const textLen = visibleTextLen(dom);
    const consoleErrors = parseConsoleErrors(res.stderr);
    const ok = !res.timedOut && dom.length > 200 && textLen > 0;
    const note = res.timedOut
      ? `render timed out after ${ms}ms`
      : `${entry}: ${textLen} visible chars, ${consoleErrors.length} error line(s)`;
    return { ok, entry, renderedTextLen: textLen, domBytes: dom.length, consoleErrors, note };
  } catch {
    return null;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
