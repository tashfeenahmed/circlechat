import { ArrowUpRight } from "lucide-react";
import { useBus } from "../state/store";
import { kindFor, ICON_FOR, STYLE_FOR, formatSize } from "../lib/fileKind";

export interface Attachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
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
