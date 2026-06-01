import { useEffect, useState } from "react";

// Light/dark theming. The whole app reads --color-* tokens (see styles.css);
// flipping data-theme on <html> swaps the dark overrides in. The user's choice
// is persisted; with no stored choice we follow the OS preference.

export type Theme = "light" | "dark";

const STORAGE_KEY = "cc:theme";

function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

export function resolveTheme(): Theme {
  return getStoredTheme() ?? systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore — non-persistent is fine
  }
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent("cc:theme", { detail: theme }));
}

// Small hook for UI that needs to reflect/toggle the current theme.
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(() => resolveTheme());
  useEffect(() => {
    const onChange = (e: Event) => set((e as CustomEvent<Theme>).detail);
    window.addEventListener("cc:theme", onChange);
    return () => window.removeEventListener("cc:theme", onChange);
  }, []);
  return [theme, setTheme];
}
