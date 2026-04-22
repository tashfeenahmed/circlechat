---
name: agent-browser
description: >
  Drive a real headless Chromium on the workspace host to read pages, fill
  forms, click buttons, run JS, and take screenshots. Use this whenever you
  need more than `curl` — i.e. pages that require JS to render, pages with
  an interactive element you have to click through, or when you want the
  accessibility-tree snapshot instead of raw HTML. Sessions persist between
  calls until you explicitly `close`, so you can navigate, snapshot, click,
  and read in separate turns.
tags: [browser, web, scraping, research, outreach]
triggers:
  - browse a URL
  - fetch a page
  - read a site
  - fill a form
  - screenshot a page
  - accessibility tree
  - snapshot a page
---

# agent-browser — browser automation over HTTP

The Chromium browser runs as a shared daemon on the host (one browser across
all agents). You drive it by POST'ing to `/agent-api/browser` with the CLI
`cmd` + `args` you would have run directly. Response is stdout/stderr/exitCode
in JSON.

## Auth

```
Authorization: Bearer <your bot token>
```

Same token you use for every other `/agent-api/*` endpoint.

## Request shape

```json
{
  "cmd": "<subcommand, e.g. \"open\" | \"snapshot\" | \"get text\">",
  "args": ["<arg>", "<arg>"],
  "stdin": "<optional — piped into agent-browser>"
}
```

`cmd` is the verb (1–3 whitespace-separated words: `open`, `get text`,
`find role`). `args` are the positional args. The server sets `BROWSER_PATH`
for you — you don't need to point at Chromium yourself.

## Copy-paste recipes (curl)

**Read a URL's visible text** (default for research):

```bash
curl -s -X POST "$API/agent-api/browser" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"cmd":"open","args":["https://example.com"]}'
curl -s -X POST "$API/agent-api/browser" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"cmd":"get text","args":["body"]}'
curl -s -X POST "$API/agent-api/browser" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"cmd":"close"}'
```

**Accessibility snapshot with element refs** (best for AI — gives you `@e1`,
`@e2`, … identifiers to click/fill by):

```bash
curl -s -X POST "$API/agent-api/browser" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"snapshot"}'
```

**Click an element by ref from a snapshot**:

```bash
curl -s -X POST "$API/agent-api/browser" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"click","args":["@e3"]}'
```

**Find + act by semantic locator** (preferred when you don't want to snapshot
first — works across page redesigns):

```bash
curl -s -X POST "$API/agent-api/browser" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"find role","args":["button","click","--name","Submit"]}'
```

**Evaluate JavaScript** on the current page:

```bash
curl -s -X POST "$API/agent-api/browser" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"eval","args":["document.title"]}'
```

## Rules

- **Always `close` when you're done.** The browser state is shared across all
  agents — leaving a modal open or a session logged in affects your colleagues.
- **One `open` per turn if you can.** Opening, snapshotting, reading, and
  closing is cheaper than navigating multiple sites in one chain.
- **Prefer `curl` over `agent-browser`** for plain, static pages — it's 10×
  faster and doesn't burn browser resources. Reach for the browser when the
  page needs JS to render, when you need to interact (click/fill), or when
  you want the a11y tree.
- **Don't log in anywhere** without explicit human permission. Stored cookies
  live in the shared browser's user-data dir.
- **Screenshots land on the host filesystem.** You don't have a way to read
  them back — skip `screenshot` unless a human specifically asked for one.

## When to use this vs. other tools

| Goal | Tool |
|---|---|
| Read a plain static page | `curl`, one shot |
| Read a JS-rendered SPA, a page behind a paywall banner, etc. | `agent-browser open` + `get text` |
| Scrape structured data (titles, headings) | `agent-browser snapshot` → parse refs |
| Interact (click, fill, submit) | `agent-browser find` or `click @eN` by ref |
| Get a PDF of a page | `agent-browser pdf` |
| Run JS to extract computed state | `agent-browser eval` |

If you promise to "look something up online" to a colleague, **actually do it
in this turn** before writing the reply.
