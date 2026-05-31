# Performance harness — "Measurement, not vibes" (PLAN.html §16)

Report-only, regression-vs-baseline. Nothing here blocks a merge; it measures
the §16 budgets, compares each run to `baseline.json`, and posts a report.

## Stages

| Stage | Needs | Measures |
|---|---|---|
| `bundle` | `web/dist` (run `npm --prefix ../web run build`) | gzip size of the **initial** client payload (entry + preloads parsed from `index.html`) → `client_bundle_gzip_kb` |
| `lighthouse` | `web/dist` + Chrome | FCP / LCP / TBT / TTI / perf-score on the public `/login` & `/signup` pages |
| `backend` | a running stack at `$PERF_BASE_URL` | `POST /messages` round-trip p50/p95 and WS fan-out p95 (`POST → message.new`) |
| `wsload` | a running stack | delivered WS throughput across N subscriber sockets (scaled-down proxy — see caveat) |

The authed chat shell is **not** Lighthouse-audited (would need a seeded login
flow); `backend`/`wsload` cover the server hot paths instead.

## Run it

```bash
npm install

# Synthetic only (no backend needed):
npm --prefix ../web run build
node run.mjs bundle lighthouse

# Everything, against a local stack:
#   docker compose -f ../compose.yml -f compose.ci.yml up -d --build \
#     postgres redis minio minio-setup api
PERF_BASE_URL=http://localhost:3000 node run.mjs

# Update the committed baseline after an intentional perf change:
node run.mjs --update-baseline      # then commit baseline.json
```

Flags: `--strict` (exit 1 on a 🔒-gated regression — off by default),
`--base-url <url>`, `--update-baseline`. Env knobs: `PERF_BASE_URL`,
`PERF_BACKEND_SAMPLES`, `PERF_WS_CONNS`, `PERF_WS_MSGS`, `CHROME_PATH`.

## Budgets & gating

`budgets.json` holds the §16 numbers. `regressionPct` is the allowed drift vs
baseline before a metric is flagged `REGRESSED` (10% for paint/bundle, 20% for
latency — the §16 rule). `gate: true` marks the metrics that *would* fail a
future `--strict` run. Today everything is report-only.

## CI

`.github/workflows/perf.yml` runs on every PR/push: builds web, boots an
ephemeral stack (api published on `:3000`, no Caddy/TLS), runs all stages,
uploads `report.md`/`results.json`, and upserts a single PR comment. It always
exits 0.

## Honest caveats

- **`ws_throughput_msgs_per_sec` is a scaled-down proxy**, not §16's
  ">50,000 msgs/sec/core". One CI poster + a handful of sockets won't reach 50k;
  the number is for tracking regressions, not certifying the absolute budget. A
  real multi-node load generator (k6 / autocannon) is the eventual upgrade.
- **`tti_login_ms`** is a cold Lighthouse measurement; §16's 250 ms TTI budget
  is the *warm/cached* shell. Treated as informational.
- **`api_post_message_p50_ms`** is a server round-trip; §16's 30 ms
  send-to-render budget is *client optimistic-UI* (instant), which RUM (deferred)
  would capture. This is the closest server-side proxy.
- RUM (web-vitals from real browsers) is **not** built yet — deliberately
  deferred. When added it supersedes the synthetic numbers for real p50/p95.
