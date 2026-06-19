# Shared multi-file project memory (`/workspace/projects`)

A file-based "blackboard" the agents form and manage themselves: multiple
markdown files per project that the whole team reads and writes across turns.
It complements the two context layers that already existed:

| Layer | Scope | Who writes | Storage |
|---|---|---|---|
| `BRIEF.md` | one human-pinned brief for the whole workspace | human | file (`/workspace/BRIEF.md`) |
| `team` memory block | one shared prose whiteboard | agents (`memory_append`) | DB row |
| **project tracker (this)** | **many files per project** | **agents (`project_note`)** | **files (`/workspace/projects/<slug>/*.md`)** |

It closes the gap identified in the deep-research report: there was no
convention where agents themselves FORM and MANAGE a shared, multi-file
markdown project layer and reliably reference it across turns and agents.

## Prior art it’s grounded in

- **Cline / Roo "Memory Bank"** — a fixed set of named markdown files per project
  (brief / context / decisions / status / progress). The convention.
- **Claude Code memory** — an always-loaded **index**, topic files fetched on
  demand. The token-budget discipline (don’t "read the whole board").
- **Letta memory blocks** — append is concurrency-safe; rewrites need a single
  owner. The write model.
- **Blackboard architecture (Nii 1986; Hearsay-II)** — agents coordinate through
  a shared store, partitioned into levels, each entry carrying provenance.

Full citations in the research report (`deep-research` run, 2026-06-19).

## Layout

```
/workspace/projects/
  INDEX.md                 # auto-generated map (do not edit); for shell browsing
  <project-slug>/
    brief.md               # goals / scope (owner-gated)
    status.md              # current focus + next steps (high churn)
    decisions.md           # append-only decision log
    changelog.md           # what shipped
    <anything>.md          # per-component notes etc.
```

Files carry optional YAML frontmatter:

```yaml
---
summary: one-line shown in the index
owner: rachel            # gates mode:"replace"
updated_by: phil         # set automatically on each write
triggers: [neu, website] # inject this file when the run is about these
always: false            # true ⇒ always injected (use for the active project's status)
---
```

`updated_at` is **not** stored — it’s derived from file mtime, so it never drifts
and append stays a pure append.

## How agents reference it (retrieval)

Assembled in `context.ts` → `buildProjectContext()` and injected into every prompt
by the bridge (`hermes-multi-bridge.mjs`), within a token budget:

- **`projectIndex`** — a per-turn DERIVED map of every project + its files
  (summary, owner, freshness). Always injected, capped ~2 KB. Never stale because
  it’s recomputed from disk each turn.
- **`projectFiles`** — the file BODIES that matched this run, fetched on demand:
  a file matches when `always:true`, its `triggers` hit the run text, its project
  slug appears, or its name appears. Max 4 files / 5 KB total.
- Anything not injected is one `cat /workspace/projects/<slug>/<file>` away —
  the dir is on the shared mount every agent already has.

This is the "always-load-index, fetch-on-demand" pattern — deliberately NOT the
blackboard anti-pattern of injecting the whole store every turn.

## How agents write it (the `project_note` action)

```json
{"type":"project_note","project":"neu-website","file":"status.md",
 "note":"Homepage redesign moved to review.","mode":"append",
 "summary":"Current focus + next steps","triggers":["neu","website"]}
```

- **`mode:"append"` (default)** — adds a `## <date> · @handle` attributed entry.
  Always allowed, concurrency-safe. Use for logs/status/decisions and to add to a
  teammate’s file.
- **`mode:"replace"`** — overwrites the file. **Owner-gated**: only the
  frontmatter `owner` (or the creator of a new file) may replace it. Use to
  compact a file that’s grown stale.

Implemented in `lib/project-files.ts` (`writeProjectFile` → `applyProjectWrite`),
dispatched in `executor.ts`. Same scope as task writes (`tasks.write`),
auto-replayable on approval. Per-file in-process mutex serialises writes; a
20 KB per-file cap forces compaction instead of unbounded growth.

## Failure-mode mitigations (from the research)

| Failure | Mitigation |
|---|---|
| invented facts | per-entry `@handle · date` provenance; prompt says "don’t fabricate" |
| contradictions / clobbering | append-only default; rewrites owner-gated |
| runaway growth / context rot | 20 KB file cap → forced compaction; index-then-fetch budget |
| token blowout | derived index capped; ≤4 files / 5 KB injected |
| stale index | index is derived from disk every turn, never hand-maintained |

## Files touched

- `api/src/lib/project-files.ts` — new shared lib (paths, frontmatter, write,
  index, retrieval). Pure helpers unit-tested.
- `api/src/agents/context.ts` — `workspace.projectIndex` + `workspace.projectFiles`.
- `api/src/agents/executor.ts` — `project_note` action (type, validation, scope,
  alias, auto-replay, dispatch).
- `api/hermes-multi-bridge.mjs` — renders the PROJECT TRACKER block + documents
  the action.
- `api/src/__tests__/project-files.test.ts` — unit + temp-mount round-trip tests.

No DB migration: the layer is entirely filesystem-based on the shared
`/workspace` mount (`CC_WORKSPACE_MOUNT`, default `/workspace`).

## Future (deferred)

- Semantic retrieval over `components/*.md` (reuse `EMBEDDINGS_*`).
- Scheduled compaction agent — only if telemetry shows growth (the research
  verifier REFUTED that an active "cleaner" is necessary; measure first).
- Public/private per-agent project scoping.
