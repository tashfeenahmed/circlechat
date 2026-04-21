import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

export function renderMarkdown(
  body: string,
  isAgentHandle: (handle: string) => boolean = () => false,
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
  return DOMPurify.sanitize(withMentions, {
    ADD_ATTR: ["target", "rel"],
    ALLOWED_ATTR: ["class", "href", "title", "target", "rel"],
  });
}
