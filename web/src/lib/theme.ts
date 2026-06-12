import { useEffect, useState } from "react";

// Light/dark theming. The whole app reads --color-* tokens (see styles.css);
// flipping data-theme on <html> swaps the dark overrides in. The user picks a
// MODE — light, dark, or system — and we resolve it to a concrete theme.
// "system" tracks the OS preference live (matchMedia listener), so flipping
// the OS appearance re-themes the app without a reload.

export type Theme = "light" | "dark";
export type ThemeMode = Theme | "system";

const STORAGE_KEY = "cc:theme";

function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function getStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // Legacy values were only ever "light"/"dark"; absent = follow the OS.
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(mode: ThemeMode = getStoredMode()): Theme {
  return mode === "system" ? systemTheme() : mode;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore — non-persistent is fine
  }
  applyTheme(resolveTheme(mode));
  window.dispatchEvent(new CustomEvent("cc:theme", { detail: mode }));
}

// Boot: apply the stored/preferred theme (called before first paint to avoid a
// flash) and keep following the OS while the mode is "system".
export function initTheme(): void {
  applyTheme(resolveTheme());
  try {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (getStoredMode() === "system") applyTheme(systemTheme());
      });
  } catch {
    // matchMedia unavailable — static theme is fine
  }
}

// Small hook for UI that needs to reflect/change the current theme mode.
export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, set] = useState<ThemeMode>(() => getStoredMode());
  useEffect(() => {
    const onChange = (e: Event) => set((e as CustomEvent<ThemeMode>).detail);
    window.addEventListener("cc:theme", onChange);
    return () => window.removeEventListener("cc:theme", onChange);
  }, []);
  return [mode, setThemeMode];
}
