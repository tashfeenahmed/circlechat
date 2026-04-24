import {
  FileText,
  FileSpreadsheet,
  FileCode,
  FileVideo,
  FileAudio,
  FileArchive,
  File as FileIcon,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";
import { useBus } from "../state/store";

export interface Attachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

type Kind = "pdf" | "doc" | "sheet" | "text" | "video" | "audio" | "archive" | "code" | "generic";

function kindFor(ct: string, name: string): Kind {
  const c = (ct || "").toLowerCase();
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (c === "application/pdf" || ext === "pdf") return "pdf";
  if (c.startsWith("video/")) return "video";
  if (c.startsWith("audio/")) return "audio";
  if (
    c.includes("spreadsheet") ||
    c === "text/csv" ||
    c === "application/vnd.ms-excel" ||
    ext === "csv" ||
    ext === "xlsx" ||
    ext === "xls" ||
    ext === "ods"
  )
    return "sheet";
  if (
    c.includes("msword") ||
    c.includes("officedocument.wordprocessing") ||
    ext === "doc" ||
    ext === "docx" ||
    ext === "odt" ||
    ext === "rtf"
  )
    return "doc";
  if (
    c === "application/zip" ||
    c === "application/x-tar" ||
    c === "application/gzip" ||
    c === "application/x-7z-compressed" ||
    ["zip", "tar", "gz", "7z", "rar"].includes(ext)
  )
    return "archive";
  if (
    c === "application/json" ||
    c === "application/xml" ||
    c === "text/xml" ||
    c === "application/javascript" ||
    c === "application/x-yaml" ||
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "json",
      "yaml",
      "yml",
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
    ].includes(ext)
  )
    return "code";
  if (c.startsWith("text/") || ["md", "txt", "log"].includes(ext)) return "text";
  return "generic";
}

const ICON_FOR: Record<Kind, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  text: FileText,
  sheet: FileSpreadsheet,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  code: FileCode,
  generic: FileIcon,
};

// Utility-class fragments keep the palette in one spot. Using tailwind
// tokens means no new CSS and no new CSS vars — they compose with the
// existing design system.
const STYLE_FOR: Record<Kind, { bg: string; fg: string; label: string }> = {
  pdf: { bg: "bg-red-50", fg: "text-red-600", label: "PDF" },
  doc: { bg: "bg-blue-50", fg: "text-blue-600", label: "DOC" },
  text: { bg: "bg-slate-100", fg: "text-slate-600", label: "TXT" },
  sheet: { bg: "bg-emerald-50", fg: "text-emerald-600", label: "SHEET" },
  video: { bg: "bg-pink-50", fg: "text-pink-600", label: "VIDEO" },
  audio: { bg: "bg-amber-50", fg: "text-amber-600", label: "AUDIO" },
  archive: { bg: "bg-stone-100", fg: "text-stone-600", label: "ARCHIVE" },
  code: { bg: "bg-zinc-100", fg: "text-zinc-700", label: "CODE" },
  generic: { bg: "bg-slate-100", fg: "text-slate-500", label: "FILE" },
};

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function isImage(ct: string): boolean {
  return /^image\//.test(ct || "");
}

export default function Attachments({ files }: { files: Attachment[] }) {
  const open = useBus((s) => s.openViewer);
  if (!files?.length) return null;
  const images = files.filter((f) => isImage(f.contentType));
  const others = files.filter((f) => !isImage(f.contentType));
  return (
    <div className="att-group">
      {images.length > 0 && (
        <div className="att-images">
          {images.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => open(f, files)}
              className="att-image"
              title={`${f.name} · ${formatSize(f.size)}`}
            >
              <img src={f.url} alt={f.name} loading="lazy" />
              <span className="att-image-meta">
                <span className="att-image-name">{f.name}</span>
                {f.size > 0 && <span className="att-image-size">{formatSize(f.size)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="att-files">
          {others.map((f) => (
            <FilePill key={f.key} f={f} onOpen={() => open(f, files)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilePill({ f, onOpen }: { f: Attachment; onOpen: () => void }) {
  const k = kindFor(f.contentType, f.name);
  const Icon = ICON_FOR[k];
  const style = STYLE_FOR[k];
  const size = formatSize(f.size);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="att-file"
      title={f.contentType || f.name}
    >
      <span className={`att-file-icon ${style.bg} ${style.fg}`}>
        <Icon size={16} strokeWidth={1.8} />
      </span>
      <span className="att-file-info">
        <span className="att-file-name" title={f.name}>
          {f.name}
        </span>
        <span className="att-file-meta">
          <span className="att-file-kind">{style.label}</span>
          {size && (
            <>
              <span className="att-file-dot">·</span>
              <span>{size}</span>
            </>
          )}
        </span>
      </span>
      <span className="att-file-open" aria-hidden="true">
        <ArrowUpRight size={13} strokeWidth={2} />
      </span>
    </button>
  );
}
