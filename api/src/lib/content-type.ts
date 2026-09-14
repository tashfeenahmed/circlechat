// One content-type table for every upload path.
//
// There used to be four: routes/files.ts guessed from the extension when
// SERVING a blob, while routes/uploads.ts, /agent-api/uploads, the artifact
// ingest and the executor's share_files each stored whatever the client (or
// the remote server, or nothing at all) claimed. The result on live
// circlechat.co: three different content types across nine `.md` attachments
// — `text/markdown`, `text/plain` and `application/octet-stream` — so the same
// kind of file opened inline in one row of /files and popped a download dialog
// in the next.
//
// The extension is the reliable signal here: every one of these blobs is
// written by us with a sanitized filename, and a client-declared mimetype is
// unverified input. So the extension wins; the declared type is only a
// fallback for extensions we don't know, and `application/octet-stream` is the
// floor.
//
// Serving is unaffected — routes/files.ts already re-derives from the key on
// the read path, and keeps its sandboxed CSP.

const BY_EXTENSION: Record<string, string> = {
  // Agent deliverables are mostly web pages, and serving them as
  // application/octet-stream meant "open in new tab" saved a file instead of
  // showing the work. Declaring the real type is safe because every /files/*
  // response carries BLOB_CSP, whose `sandbox` directive drops the document
  // into an opaque origin with scripts disabled (see routes/files.ts).
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  json: "application/json",
  ndjson: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
  gz: "application/gzip",
};

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function extensionOf(nameOrKey: string): string {
  const base = String(nameOrKey || "").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

// The stored/served content type for a file name or storage key. Pure.
// `declared` is the client's claim — used only when the extension is unknown,
// and never trusted to override a known one.
export function contentTypeForName(nameOrKey: string, declared?: string | null): string {
  const known = BY_EXTENSION[extensionOf(nameOrKey)];
  if (known) return known;
  const claimed = (declared || "").split(";")[0].trim().toLowerCase();
  // An empty or generic claim is no information at all.
  if (!claimed || claimed === DEFAULT_CONTENT_TYPE) return DEFAULT_CONTENT_TYPE;
  return claimed;
}

// True for bodies we may safely run the public-read path scrub over (issue: an
// artifact's own text still quoted /opt/data/... container paths). Binary types
// are never touched.
export function isScrubbableTextType(contentType: string): boolean {
  const t = (contentType || "").toLowerCase();
  return t.startsWith("text/") || t.includes("markdown") || t.includes("html");
}
