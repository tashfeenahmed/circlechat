import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  items: MenuItem[];
  title?: string;
  className?: string;
  align?: "start" | "end";
  children?: React.ReactNode; // trigger content; defaults to horizontal dots
}

export default function Menu({ items, title = "More", className, align = "end", children }: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function open() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 220;
    const left = align === "end" ? r.right - width : r.left;
    const clampedLeft = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left: clampedLeft });
  }
  function close() { setPos(null); }

  useEffect(() => {
    if (!pos) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onDoc(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (btnRef.current?.contains(target)) return;
      const menu = document.getElementById("__cc_menu_popover");
      if (menu && menu.contains(target)) return;
      close();
    }
    function onScroll() { close(); }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className ?? "tb-btn inline-flex items-center gap-1"}
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        onClick={() => (pos ? close() : open())}
      >
        {children ?? <MoreHorizontal size={14} strokeWidth={2} />}
      </button>
      {pos &&
        createPortal(
          <div
            id="__cc_menu_popover"
            role="menu"
            className="menu-popover"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            {items.map((it, i) => (
              <button
                key={i}
                role="menuitem"
                disabled={it.disabled}
                className={`menu-item ${it.danger ? "danger" : ""}`}
                onClick={() => { close(); it.onSelect(); }}
              >
                {it.icon && <span className="menu-icon">{it.icon}</span>}
                <span>{it.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
