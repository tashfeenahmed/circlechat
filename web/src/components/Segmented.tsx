import type { ReactNode } from "react";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

// A small iOS-style segmented toggle on Base UI ToggleGroup: arrow-key nav,
// focus management and aria-pressed semantics come from the library. The
// active segment lifts onto a paper "pill" inside a tinted track. Generic
// over the value union so callers stay type-safe.
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
    <ToggleGroup
      className={`seg seg--${size}`}
      aria-label={ariaLabel}
      value={[value]}
      onValueChange={(next: unknown[]) => {
        // Single-select that can't be toggled off: ignore the empty set the
        // group emits when the active segment is clicked again.
        const v = next[0] as T | undefined;
        if (v && v !== value) onChange(v);
      }}
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          className={`seg-opt${value === o.value ? " active" : ""}`}
        >
          {o.icon && <span className="seg-opt-icon">{o.icon}</span>}
          <span>{o.label}</span>
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
