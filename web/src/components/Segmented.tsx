import type { ReactNode } from "react";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

// A small iOS-style segmented toggle. The active segment lifts onto a paper
// "pill" inside a tinted track, so the choice reads clearly instead of two
// cramped buttons. Generic over the value union so callers stay type-safe.
export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  return (
    <div className={`seg seg--${size}`} role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={`seg-opt${value === o.value ? " active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <span className="seg-opt-icon">{o.icon}</span>}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
