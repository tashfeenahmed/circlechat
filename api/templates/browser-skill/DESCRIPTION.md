---
name: agent-browser
description: >
  Drive a real headless Chromium on the workspace host to read pages, fill
  forms, click buttons, run JS, and take screenshots. Use this whenever you
  need more than a plain HTTP fetch — pages that require JS to render, pages
  with an interactive element you have to click through, or when you want an
  accessibility-tree snapshot with element refs instead of raw HTML. Sessions
  persist between calls until you explicitly `close`, so you can navigate,
  snapshot, click, and read in separate turns.
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

Chromium runs as a shared daemon on the host (one browser across all agents).
You drive it by POST'ing to `/agent-api/browser` with the CLI verb + args.
Response is `{exitCode, stdout, stderr}` as JSON.

## The shell you're in

**Hermes agents** (Nova, Ada, …): your container has `python3` but **not
`curl`**. Use `python3` for every HTTP call below.

**OpenClaw agents** (Max, …): your container has both `curl` and `python3`.
Either works; `curl` is shorter.

## Python helper (works everywhere)

Paste this at the top of your terminal block, then call `ab()` repeatedly in
the same turn:

```python
import json, os, urllib.request
API = os.environ.get("CC_API_BASE", "http://localhost:3300/api")
TOKEN = os.environ["CC_BOT_TOKEN"]
def ab(cmd, args=None, stdin=None):
    body = json.dumps({"cmd": cmd, "args": args or [], "stdin": stdin}).encode()
    req = urllib.request.Request(
        f"{API}/agent-api/browser",
        data=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=50) as r:
        return json.loads(r.read())
```

## Recipes

**Read the visible text of a page** (most common — research/citations):

```python
ab("open", ["https://example.com"])
print(ab("get text", ["body"])["stdout"])
ab("close")
```

**Accessibility snapshot with element refs** (best for AI — gives you `@e1`,
`@e2`, … handles to click/fill by):

```python
print(ab("snapshot")["stdout"])
```

**Click an element by ref from a snapshot**:

```python
ab("click", ["@e3"])
```

**Find + act by semantic locator** (resilient to page redesigns):

```python
ab("find role", ["button", "click", "--name", "Submit"])
ab("find text", ["Sign In", "click"])
ab("find label", ["Email", "fill", "test@example.com"])
```

**Evaluate JavaScript on the current page**:

```python
print(ab("eval", ["document.title"])["stdout"])
```

**Open → snapshot → extract → close in one turn** (preferred):

```python
ab("open", ["https://news.ycombinator.com"])
snap = ab("snapshot")["stdout"]
# parse snap for refs, then act
ab("close")
```

## curl version (OpenClaw only — Hermes containers have no curl)

```bash
curl -s -X POST "$CC_API_BASE/agent-api/browser" \
  -H "Authorization: Bearer $CC_BOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"cmd":"open","args":["https://example.com"]}'
```

## Rules

- **Always `close` when you're done.** Browser state is shared across all
  agents — leaving a modal open or a session logged in affects colleagues.
- **One `open` per turn if you can.** Opening, snapshotting, reading, and
  closing in a single turn is cheaper than spreading across multiple turns.
- **Prefer a plain HTTP fetch over the browser** for static pages — the
  browser is ~10× slower and burns host RAM. Reach for the browser when JS
  must render, when you need to click/fill, or when you want the a11y tree.
- **Don't log in anywhere** without explicit human permission. Cookies
  persist in the shared user-data dir across agents.
- **Screenshots land on the host filesystem.** You can't read them back, so
  skip `screenshot` unless a human explicitly asked for a visual.

## When to use this vs. other tools

| Goal | Tool |
|---|---|
| Read a static page | plain HTTP (urllib) |
| Read a JS-rendered SPA, a page behind a banner | `ab("open")` + `ab("get text", ["body"])` |
| Scrape structured data (titles, links) | `ab("snapshot")` → parse refs |
| Interact (click, fill, submit) | `ab("find …")` or `ab("click", ["@eN"])` |
| Get a PDF of a page | `ab("pdf", ["out.pdf"])` |
| Run JS to extract computed state | `ab("eval", ["<js>"])` |

If you promise a colleague you'll "look something up online", **do it in the
same turn** before writing the reply.
