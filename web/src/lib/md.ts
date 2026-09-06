import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

// Open links in a new tab. markdown-it emits a bare <a href> by default, so
// links would otherwise navigate away from the app in the same tab. rel
// guards against tabnabbing on the opened page. (DOMPurify keeps target/rel.)
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// ─────────────────────────── scrubIds ───────────────────────────
// The markdown path below turns ids and hashes into chips, but plenty of agent
// text is rendered as PLAIN TEXT — a task title, a board card label, a goal
// body, an agent's brief, a "Needs you" detail line. Those surfaces were
// showing raw `task_…` ids, SHA-256 digests, container paths
// (`/opt/data/workspace/backend/server.js`) and `localhost:3000` to visitors.
//
// scrubIds is the plain-text counterpart of chipIds: same vocabulary, no HTML.
// It is deliberately conservative — it rewrites machine identifiers and runtime
// paths and leaves every other word alone.
//
// Mirrors the rewrite table in api/src/agents/reply-guard.ts
// (`sanitizeAgentProse`), which stops this text being written in the first
// place. This one cleans what is already stored.
// Leading group is the delimiter, kept verbatim — avoids a lookbehind so the
// expression stays portable across browser regex engines.
const RUNTIME_PATH_RE = /(^|[\s("'`[<])(\/(?:opt\/data|workspace|tmp)(?:\/[\w.@%+-]+)*)\/?/g;
const PORT_URL_RE = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?(?:\/[\w./?=&%-]*)?/gi;
const ON_PORT_RE = /\s*\b(?:on|at|via)\s+port\s+\d{2,5}\b/gi;
const BARE_PORT_RE = /(^|[\s(])::?\d{2,5}\b/g;

export function scrubIds(text: string): string {
  if (!text) return "";
  let out = String(text);
  // Internal ids → what the thing actually is.
  out = out.replace(/\btask_[a-z0-9]{12,28}\b/g, "this card");
  out = out.replace(/\bap_[a-z0-9]{12,28}\b/g, "an approval");
  out = out.replace(/\bgoal_[a-z0-9]{12,28}\b/g, "this goal");
  // Content digests / commit hashes → a short, still-recognisable prefix.
  out = out.replace(/\b([0-9a-f]{32,64})\b/g, (_m, h: string) => `${h.slice(0, 8)}…`);
  // Container paths → the bare filename. `/workspace/backend/server.js` is
  // meaningless to a reader; `server.js` is the part they can act on. A bare
  // directory ("/workspace") leaves nothing worth printing.
  out = out.replace(RUNTIME_PATH_RE, (_m, pre: string, p: string) => {
    const last = p.split("/").filter(Boolean).pop() ?? "";
    const keep = last && last !== "workspace" && last !== "tmp" && last !== "data" ? last : "";
    return `${pre}${keep}`;
  });
  // Local dev endpoints → "the server"; port mentions → gone.
  out = out.replace(PORT_URL_RE, "the server");
  out = out.replace(ON_PORT_RE, "");
  out = out.replace(BARE_PORT_RE, "$1");
  // Tidy up the whitespace/punctuation the removals leave behind.
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Agents refer to board cards, approvals and files by their internal ids and
// hashes. Humans should never have to read `task_tor0bjwcr6zcasklr4sq`: cards
// become a chip with the card's title (linking to the board), approval ids a
// plain "approval" chip, and long hashes a short code span.
export type TaskResolver = (taskId: string) => string | null | undefined;
function chipIds(html: string, resolveTask?: TaskResolver): string {
  let out = html.replace(/(?:<code>)?\b(task_[a-z0-9]{12,28})\b(?:<\/code>)?/g, (_m, id: string) => {
    const title = resolveTask?.(id);
    const label = title ? escapeHtml(title.length > 60 ? `${title.slice(0, 57)}…` : title) : "task card";
    return `<a class="idchip task" href="/board?task=${id}" title="Open card">◇ ${label}</a>`;
  });
  out = out.replace(/(?:<code>)?\b(ap_[a-z0-9]{12,28})\b(?:<\/code>)?/g, '<a class="idchip approval" href="/approvals" title="Open approvals">✓ approval</a>');
  out = out.replace(/(?:<code>)?\b(goal_[a-z0-9]{12,28})\b(?:<\/code>)?/g, '<a class="idchip goal" href="/goals" title="Open goals">◎ goal</a>');
  // 32+ hex chars = SHA-1/SHA-256 style digests; keep the first 8 for eyeballing.
  out = out.replace(/(?:<code>)?\b([0-9a-f]{32,64})\b(?:<\/code>)?/g, (_m, h: string) => `<code class="hash" title="${h}">${h.slice(0, 8)}…</code>`);
  return out;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderMarkdown(
  body: string,
  isAgentHandle: (handle: string) => boolean = () => false,
  resolveTask?: TaskResolver,
): string {
  // Render markdown first (escapes user-supplied HTML because html:false).
  const base = md.render(body);
  // Inject mention chips on the rendered (escaped) HTML.
  const withMentions = base.replace(
    /(^|[\s(>])@([a-z0-9][a-z0-9._-]{1,39})/gi,
    (_m, pre, h) => {
      const lower = h.toLowerCase();
      const klass =
        lower === "everyone" || lower === "channel"
          ? "mention everyone"
          : isAgentHandle(lower)
            ? "mention agent"
            : "mention";
      return `${pre}<span class="${klass}">@${h}</span>`;
    },
  );
  const withChips = chipIds(withMentions, resolveTask);
  return DOMPurify.sanitize(withChips, {
    ADD_ATTR: ["target", "rel"],
    // `style` is allowed so GFM table column alignment (markdown-it emits
    // `style="text-align:…"` on th/td) survives — DOMPurify sanitizes the
    // CSS value, so this stays safe.
    ALLOWED_ATTR: ["class", "href", "title", "target", "rel", "style"],
  });
}
