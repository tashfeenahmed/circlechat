import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: "top" | "bottom";
  delay?: number;
  className?: string;
}

// Lightweight tooltip: renders into a portal so it's never clipped by parent
// overflow. Wraps a single child; the child keeps its own click handlers.
// Shows after `delay` ms (default 120), hides on leave with no lag.
export default function Tooltip({ content, children, placement = "top", delay = 120, className }: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const openT = useRef<number | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; align: "top" | "bottom" } | null>(null);

  useEffect(() => {
    return () => {
      if (openT.current) window.clearTimeout(openT.current);
    };
  }, []);

  function compute(): void {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    // Default to requested placement; flip if there's not enough room.
    const wantTop = placement === "top";
    const roomTop = r.top;
    const roomBottom = vh - r.bottom;
    const align: "top" | "bottom" =
      wantTop && roomTop < 40 ? "bottom" : !wantTop && roomBottom < 40 ? "top" : wantTop ? "top" : "bottom";
    const centerX = r.left + r.width / 2;
    setPos({
      top: align === "top" ? r.top - 6 : r.bottom + 6,
      left: centerX,
      align,
    });
  }

  function onEnter(): void {
    if (openT.current) window.clearTimeout(openT.current);
    openT.current = window.setTimeout(compute, delay);
  }
  function onLeave(): void {
    if (openT.current) {
      window.clearTimeout(openT.current);
      openT.current = null;
    }
    setPos(null);
  }

  const tip = pos ? (
    <div
      className={`tooltip ${pos.align === "top" ? "above" : "below"} ${className ?? ""}`}
      style={{
        position: "fixed",
        top: pos.align === "bottom" ? pos.top : undefined,
        bottom: pos.align === "top" ? window.innerHeight - pos.top : undefined,
        left: pos.left,
        transform: "translateX(-50%)",
      }}
    >
      {content}
    </div>
  ) : null;

  return (
    <span
      ref={wrapRef}
      className="inline-flex"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      {children}
      {tip && createPortal(tip, document.body)}
    </span>
  );
}
