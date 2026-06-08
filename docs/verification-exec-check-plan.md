# Implementation Plan — Execution Check for the Verification Gate

**Goal:** close the highest-priority hole from the Part-2 gap analysis — the verification
gate (`api/src/lib/task-verifier.ts`) judges a deliverable's *source text* but never *runs*
it, so a plausible-but-broken site passes ("certify a state it can't observe"). Add an
optional **render/execute** step whose **observed result** is fed to the existing LLM judge.

Grounded in the codebase audit (2026-06-08): reuses existing infra, adds no new dependency.

---

## Scope decision (what we build vs defer)

| Deliverable kind | Check | In this plan? |
|---|---|---|
| **Web/static site** (`.html`/`text/html`, the actual live use case) | Headless **render** via `chromium --dump-dom`; observe post-JS DOM, console errors, load success | ✅ **Phase 1** |
| **Binary "proof" deliverable** (screenshot PNG/PDF) currently bypassing the judge | For a web task, render the real source instead of trusting the image; refuse binary-as-sole-deliverable | ✅ **Phase 1** (small) |
| **App with a build/test** (`package.json` w/ `build`/`test` script) | Run the declared command in a sandbox, feed exit code + output to judge | ⏸️ **Phase 2, deferred** — heavier, sandbox/security surface, ~no current deliverables need it |

Rationale: current deliverables are static sites; a `file://` render closes the gap for the
real workload with one subprocess and zero new deps. Generic build execution is a separate,
heavier change with a real sandbox-escape surface — scoped below but not built now.

---

## Why `chromium --dump-dom`, not `agent-browser` or Playwright

- **No Playwright/Puppeteer dependency** exists; adding one is avoidable.
- `agent-browser` (used by the agent skill) is **stateful** — `open`/`snapshot`/`close` are
  separate spawns sharing an external session. Awkward and racy to drive one-shot from the API.
- `chromium --headless --dump-dom --virtual-time-budget=N file://…` is **one subprocess**:
  it executes the page's JS, waits for virtual time to settle, prints the **rendered DOM** to
  stdout, and exits non-zero on a hard load failure. Exactly the observable we want. Binary is
  already on the box (`CHROMIUM_BIN`, default `/usr/bin/chromium`).

---

## Status: Phase 1 IMPLEMENTED (2026-06-08)
Shipped behind `VERIFY_EXEC=off` (no-op until enabled). Files: new
`api/src/lib/deliverable-render.ts`, wired into `api/src/lib/task-verifier.ts`;
flags documented in `CONFIG.md` + `.env.example`. `tsc` clean.

**Smoke-tested** the Chromium `--dump-dom` primitive against three pages — the signals
separate cleanly:
| page | visible text chars | loaded_ok |
|------|--------------------|-----------|
| complete site (JS-injected footer rendered) | 167 | **true** |
| skeleton (`<h1>TODO</h1>`) | 4 | **false** |
| broken JS (undefined global, blank render) | 0 | **false** |

**Design correction found during testing:** stderr is NOT a reliable source of page errors
in `--dump-dom` mode — it surfaces Chromium's internal C++ GPU/process log spam (false
positives on healthy pages) and does **not** reliably surface page JS/network errors. Fixed
by filtering Chrome-internal `…:ERROR:path/file.cc:NNN]` lines so `consoleErrors` only ever
reports genuine `net::ERR_`/`Uncaught`/JS-error lines (usually empty — honest). **The
load-success + visible-text-length signals carry the verdict; console errors are a bonus.**

Remaining Phase-1 limitation: artifact names are flattened at ingest (`/` → `_`), so a site
referencing `assets/style.css` won't resolve that subpath in the temp dir. Flat sites
(index.html + sibling css/js, the common case) render faithfully. Sub-dir asset fidelity is a
follow-up.

## Phase 1 — design

### New env flags (opt-in, safe-by-default — matches existing gate posture)
```
VERIFY_EXEC=on             # default off. Render web deliverables before judging.
VERIFY_EXEC_TIMEOUT_MS=8000  # hard cap per render (default 8s)
CHROMIUM_BIN=/usr/bin/chromium   # already used elsewhere; reuse
```
If `VERIFY_EXEC` is off, or chromium is missing, or render errors → **skip the render and
fall back to today's text-only judge** (fail-open, never freeze the board). The render only
ever *adds* evidence; it cannot by itself block a flip on infra failure.

### New module: `api/src/lib/deliverable-render.ts`
A self-contained helper with no DB coupling.

```ts
export type RenderObservation = {
  ok: boolean;              // chromium exited 0 and produced a DOM
  entry: string;            // which file was rendered (e.g. "index.html")
  renderedTextLen: number;  // visible text length after JS (tags stripped)
  domBytes: number;         // size of dumped DOM
  consoleErrors: string[];  // parsed from stderr: "Uncaught", "ERROR:", failed reqs
  note: string;             // short human summary for the judge / logs
};

// Reconstruct the task's files into a tmp dir, render the entry HTML, observe.
export async function renderWebDeliverable(opts: {
  taskId: string;
  entryName: string;        // the chosen html artifact's name
}): Promise<RenderObservation | null>;  // null = not applicable / chromium absent
```

**Steps inside `renderWebDeliverable`:**
1. `const rows = await liveArtifactRows(taskId)` → dedupe to latest version per `name`.
2. `mkdtemp` a temp dir. For each textual/asset row: `readObject(row.storageKey)` → write to
   `safeJoin(tmp, row.name)` (path-traversal-guarded; create parent dirs). This makes
   relative `href`/`src`/`<link>` resolve so CSS/JS load like the real site.
3. Pick entry: the passed `entryName` if html, else `index.html` if present, else first html.
4. Spawn:
   ```
   chromium --headless --no-sandbox --disable-gpu --hide-scrollbars
            --dump-dom --virtual-time-budget=${timeout-1s} file://<tmp>/<entry>
   ```
   Capture stdout (rendered DOM), stderr (console/errors), exit code, with a hard
   `timeout: VERIFY_EXEC_TIMEOUT_MS` (kill on overrun). `--no-sandbox` required (container root).
5. Derive `renderedTextLen` (strip tags from stdout), `consoleErrors` (grep stderr for
   `Uncaught`, `ERROR:`, `Failed to load`), `domBytes`.
6. `rm -rf` the temp dir (best-effort). Return the observation.

**New exec helper** (reuse pattern from `hermes-equip.ts:runStrictRaw`, but capture stdout):
small `spawnCapture(cmd, args, {timeoutMs}) → {code, stdout, stderr}`. Put it next to the
render helper (it's the one piece the existing helpers don't provide — they only keep stderr
and reject on nonzero).

### Wire into `task-verifier.ts`
In `verifyTaskForDone`, after a textual `chosen` deliverable is found and before the judge call:

```ts
let renderBlock = "";
if (process.env.VERIFY_EXEC === "on" && inferType(chosen.name, chosen.contentType) === "code"
    && /\.html?$/i.test(chosen.name)) {
  const obs = await renderWebDeliverable({ taskId: opts.taskId, entryName: chosen.name })
                .catch(() => null);
  if (obs) {
    renderBlock =
      `\n\nRENDER OBSERVATION (headless Chromium actually loaded this):\n` +
      `- loaded_ok: ${obs.ok}\n- rendered_visible_text_chars: ${obs.renderedTextLen}\n` +
      `- console_errors: ${obs.consoleErrors.length ? obs.consoleErrors.slice(0,5).join(" | ") : "none"}\n`;
  }
}
```
Append `renderBlock` to the judge's **user** message (after the source), and extend the
**system** prompt: *"If a RENDER OBSERVATION is present, weight it heavily: a deliverable that
fails to load, renders almost no visible text, or throws console errors FAILS regardless of how
complete the source looks."*

Also record the observation: set `method: "render"` (vs today's mislabeled `"test"`) and stash
the observation in `rubricJson` so it's auditable in `task_verifications`.

### Binary-bypass tightening (small)
Today: `if (!isTextualContentType(r.contentType)) continue;` silently lets binaries through.
Change: when **no textual deliverable** is found **but** the task looks web/design-typed and the
only deliverables are binary (PNG/PDF), record a soft `fail` with rationale *"only a binary
proof was provided; attach the renderable source so the site can be verified"* — **but keep it
behind `VERIFY_EXEC=on`** so default behavior is unchanged.

---

## Files touched
- **NEW** `api/src/lib/deliverable-render.ts` (~120 lines: `renderWebDeliverable` + `spawnCapture`).
- **EDIT** `api/src/lib/task-verifier.ts`: render call + prompt augmentation + `method:"render"` +
  binary-bypass branch. ~25 lines.
- **EDIT** `docs/CONFIG.md` + `.env.example`: document `VERIFY_EXEC`, `VERIFY_EXEC_TIMEOUT_MS`.
- **No** schema migration — `task_verifications.method`/`rubricJson` already exist.
- **No** new npm dependency.

---

## Edge cases & failure handling
- **Chromium absent / spawn fails / timeout** → `renderWebDeliverable` returns null → judge runs
  text-only, exactly as today. Logged, never blocks.
- **Multi-file site** reconstructed by `name`; if names collide across versions, keep newest.
- **Path traversal** in artifact `name` (`../`) → guarded `safeJoin`; skip anything escaping tmp.
- **Pages that fetch the network** — `file://` render still allows outbound requests. Acceptable
  (agents already drive arbitrary URLs via agent-browser), but note as a trust caveat; a future
  `--host-resolver-rules`/no-network sandbox is a Phase-2 hardening.
- **Huge DOM** → cap dumped stdout (e.g. 200KB) before deriving metrics.
- **Fail-open invariant preserved:** render only adds evidence; only the *LLM verdict* (as today)
  can block, and only when `VERIFY_GATE=on`.

---

## Verification (how we prove the check works)
1. **Real deliverable** (a complete neu.ie `index.html` + css) → `loaded_ok:true`, high text len,
   no console errors → judge **pass**.
2. **Skeleton** (`<html><body><h1>TODO</h1></body></html>`) → tiny rendered text → judge **fail**
   (where today's text judge might be lenient on "looks like valid HTML").
3. **Broken JS** (references undefined global, blank render) → `console_errors` populated,
   `renderedTextLen` ~0 → judge **fail**.
4. **Chromium disabled** (`VERIFY_EXEC` off) → identical behavior to today (regression guard).
5. Confirm `task_verifications` row has `method:"render"` and the observation in `rubricJson`.

---

## Phase 2 (deferred, scoped only)
Generic build/test execution for app deliverables that declare a command:
- Reconstruct files → `npm ci && npm run build` (or declared script) inside the **existing
  hermes Docker sandbox** (`buildHermesCommand`, `--network=host` → tighten to none), capture
  exit + tail of output, feed to judge.
- Real sandbox-escape surface (arbitrary install scripts) → needs network-egress limits, a CPU/mem
  cap, and an allowlist of run commands. Do NOT ship on the static-site timeline.

---

## Rollout
1. Land Phase 1 behind `VERIFY_EXEC=off` (no behavior change for anyone).
2. Enable on the box (`VERIFY_EXEC=on`) where `VERIFY_GATE` is already on; watch a few
   review→done flips and the recorded observations.
3. If render-derived fails look correct, leave on; document recommended posture in CONFIG.md.
