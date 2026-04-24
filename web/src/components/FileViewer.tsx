import { useEffect, useMemo, useRef, useState } from "react";
import { X, Download, ExternalLink, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import DOMPurify from "dompurify";
import { useBus, type ViewerFile } from "../state/store";
import { renderMarkdown } from "../lib/md";

type Kind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "html"
  | "text"
  | "binary";

function kindOf(file: ViewerFile): Kind {
  const ct = (file.contentType || "").toLowerCase();
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (
    ct === "text/markdown" ||
    ct === "text/x-markdown" ||
    ["md", "mdx", "markdown"].includes(ext)
  )
    return "markdown";
  if (ct === "text/html" || ["html", "htm"].includes(ext)) return "html";
  if (
    ct.startsWith("text/") ||
    ct === "application/json" ||
    ct === "application/xml" ||
    ct === "application/javascript" ||
    ct === "application/x-yaml" ||
    [
      "txt",
      "log",
      "json",
      "xml",
      "yaml",
      "yml",
      "js",
      "jsx",
      "ts",
      "tsx",
      "py",
      "go",
      "rs",
      "sh",
      "rb",
      "java",
      "c",
      "cpp",
      "h",
      "hpp",
      "toml",
      "ini",
      "conf",
      "csv",
    ].includes(ext)
  )
    return "text";
  return "binary";
}

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export default function FileViewer() {
  const file = useBus((s) => s.viewerFile);
  const siblings = useBus((s) => s.viewerSiblings);
  const close = useBus((s) => s.closeViewer);
  const open = useBus((s) => s.openViewer);

  // Keyboard: esc to close, ←/→ to page through siblings.
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (!siblings || siblings.length < 2) return;
      const idx = siblings.findIndex((f) => f.key === file.key);
      if (e.key === "ArrowLeft" && idx > 0) open(siblings[idx - 1], siblings);
      if (e.key === "ArrowRight" && idx < siblings.length - 1)
        open(siblings[idx + 1], siblings);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, siblings, close, open]);

  if (!file) return null;
  const idx = siblings?.findIndex((f) => f.key === file.key) ?? -1;
  const hasPrev = siblings && idx > 0;
  const hasNext = siblings && idx >= 0 && idx < siblings.length - 1;

  return (
    <div className="fv-bg" onClick={close}>
      <div className="fv" onClick={(e) => e.stopPropagation()}>
        <header className="fv-head">
          <div className="fv-title">
            <span className="fv-name" title={file.name}>{file.name}</span>
            <span className="fv-meta">
              {file.contentType || "file"}
              {file.size > 0 && <> · {formatSize(file.size)}</>}
              {siblings && siblings.length > 1 && (
                <> · {idx + 1} of {siblings.length}</>
              )}
            </span>
          </div>
          <div className="fv-actions">
            <a
              className="fv-btn"
              href={file.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in new tab"
            >
              <ExternalLink size={14} strokeWidth={2} />
            </a>
            <a
              className="fv-btn"
              href={file.url}
              download={file.name}
              title="Download"
            >
              <Download size={14} strokeWidth={2} />
            </a>
            <button className="fv-btn" onClick={close} title="Close (Esc)">
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </header>
        <div className="fv-body">
          {hasPrev && (
            <button
              className="fv-nav left"
              onClick={() => siblings && open(siblings[idx - 1], siblings)}
              title="Previous (←)"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <Preview file={file} />
          {hasNext && (
            <button
              className="fv-nav right"
              onClick={() => siblings && open(siblings[idx + 1], siblings)}
              title="Next (→)"
            >
              <ChevronRight size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Preview({ file }: { file: ViewerFile }) {
  const kind = useMemo(() => kindOf(file), [file]);
  if (kind === "image") {
    return (
      <div className="fv-center">
        <img src={file.url} alt={file.name} className="fv-image" />
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="fv-center">
        <video src={file.url} controls className="fv-video" />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="fv-center">
        <audio src={file.url} controls className="fv-audio" />
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <iframe
        src={file.url}
        title={file.name}
        className="fv-iframe"
      />
    );
  }
  if (kind === "markdown") return <MarkdownPreview file={file} />;
  if (kind === "html") return <HtmlPreview file={file} />;
  if (kind === "text") return <TextPreview file={file} />;
  return <Unsupported file={file} />;
}

function useTextContent(url: string): { text: string | null; err: string | null; loading: boolean } {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    setText(null);
    setErr(null);
    fetch(url, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`http_${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (cancelledRef.current) return;
        setText(t);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelledRef.current) return;
        setErr(e.message);
        setLoading(false);
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [url]);
  return { text, err, loading };
}

function Spinner() {
  return (
    <div className="fv-loading">
      <Loader2 className="fv-spin" size={22} />
    </div>
  );
}

function ErrorPane({ err }: { err: string }) {
  return (
    <div className="fv-error">
      <div>Couldn't load file</div>
      <div className="fv-error-detail">{err}</div>
    </div>
  );
}

function MarkdownPreview({ file }: { file: ViewerFile }) {
  const { text, err, loading } = useTextContent(file.url);
  if (loading) return <Spinner />;
  if (err) return <ErrorPane err={err} />;
  const html = DOMPurify.sanitize(renderMarkdown(text ?? ""));
  return (
    <div className="fv-scroll">
      <article className="fv-md markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function HtmlPreview({ file }: { file: ViewerFile }) {
  const { text, err, loading } = useTextContent(file.url);
  if (loading) return <Spinner />;
  if (err) return <ErrorPane err={err} />;
  // Sandboxed srcdoc: scripts disabled, no same-origin, no forms or popups.
  // Keeps agent-authored HTML from reaching the session cookie or running
  // arbitrary JS. If users need live JS, they can "Open in new tab".
  return (
    <iframe
      title={file.name}
      srcDoc={text ?? ""}
      sandbox=""
      className="fv-iframe"
    />
  );
}

function TextPreview({ file }: { file: ViewerFile }) {
  const { text, err, loading } = useTextContent(file.url);
  if (loading) return <Spinner />;
  if (err) return <ErrorPane err={err} />;
  return (
    <div className="fv-scroll">
      <pre className="fv-text">{text}</pre>
    </div>
  );
}

function Unsupported({ file }: { file: ViewerFile }) {
  return (
    <div className="fv-unsupported">
      <div className="fv-unsup-title">Preview not available</div>
      <div className="fv-unsup-body">
        This file type ({file.contentType || "unknown"}) can't be previewed in
        the browser. Download it to open locally.
      </div>
      <a className="btn primary sm" href={file.url} download={file.name}>
        <Download size={14} /> Download
      </a>
    </div>
  );
}
