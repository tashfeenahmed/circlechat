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
