import {
  FileText,
  FileSpreadsheet,
  FileCode,
  FileVideo,
  FileAudio,
  FileArchive,
  FileImage,
  File as FileIcon,
  type LucideIcon,
} from "lucide-react";

export type FileKind =
  | "image"
  | "pdf"
  | "doc"
  | "sheet"
  | "text"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "generic";

export function kindFor(contentType: string, name: string): FileKind {
  const c = (contentType || "").toLowerCase();
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (c.startsWith("image/")) return "image";
  if (c === "application/pdf" || ext === "pdf") return "pdf";
  if (c.startsWith("video/")) return "video";
  if (c.startsWith("audio/")) return "audio";
  if (
    c.includes("spreadsheet") ||
    c === "text/csv" ||
    c === "application/vnd.ms-excel" ||
    ["csv", "xlsx", "xls", "ods"].includes(ext)
  )
    return "sheet";
  if (
    c.includes("msword") ||
    c.includes("officedocument.wordprocessing") ||
    ["doc", "docx", "odt", "rtf"].includes(ext)
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
      "js", "ts", "tsx", "jsx", "json", "yaml", "yml", "py", "go", "rs", "sh",
      "rb", "java", "c", "cpp", "h", "hpp", "toml",
    ].includes(ext)
  )
    return "code";
  if (c.startsWith("text/") || ["md", "txt", "log"].includes(ext)) return "text";
  return "generic";
}

export const ICON_FOR: Record<FileKind, LucideIcon> = {
  image: FileImage,
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

// Tailwind palette tokens for the small type-icon tile.
export const STYLE_FOR: Record<FileKind, { bg: string; fg: string; label: string }> = {
  image: { bg: "bg-violet-50", fg: "text-violet-600", label: "IMAGE" },
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

export function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
