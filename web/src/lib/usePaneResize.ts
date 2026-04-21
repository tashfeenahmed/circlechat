import { useRef } from "react";

// Left-edge drag handle for a right-docked pane. Pass the current width and a
// setter; returns a mousedown handler. Dragging left widens, dragging right
// narrows. Setter should clamp to sane bounds.
export function usePaneResize(width: number, setWidth: (w: number) => void) {
  const startRef = useRef<{ x: number; w: number } | null>(null);

  return (e: React.MouseEvent) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, w: width };
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (ev: MouseEvent) => {
      if (!startRef.current) return;
      const dx = ev.clientX - startRef.current.x;
      setWidth(startRef.current.w - dx);
    };
    const up = () => {
      startRef.current = null;
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
}
