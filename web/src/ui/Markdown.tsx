// SPDX-License-Identifier: AGPL-3.0-only
// Agent replies are Markdown. Render it safely: no raw HTML, links open in a new tab,
// and @mentions stay highlighted.
import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const MENTION = /(^|[^\w@/])@([a-z][a-z0-9_-]{1,30})/gi;

/** Turn @handle into a link with a private scheme, outside code spans and fenced blocks. */
function markMentions(src: string): string {
  return src
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(MENTION, (_, pre, h) => `${pre}[@${h}](mention:${h})`)))
    .join("");
}

const components: Components = {
  a: ({ href, children }) =>
    href?.startsWith("mention:") ? (
      <span className="mention">{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <span>{alt}</span>, // no remote images in chat
};

const urlTransform = (url: string) => (url.startsWith("mention:") ? url : defaultUrlTransform(url));

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform} skipHtml>
        {markMentions(text)}
      </ReactMarkdown>
    </div>
  );
});
