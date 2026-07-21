"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

/**
 * Shared light/dark theme state, persisted to localStorage ("pa-theme") and
 * applied to <html data-theme>. Used by every top-level workspace so the theme
 * toggle behaves identically wherever it appears. A pre-hydration inline script
 * in the layout already sets the initial attribute to avoid a flash.
 */
export function useTheme(): { theme: ThemeMode; toggleTheme: () => void; ready: boolean } {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem("pa-theme");
      const documentTheme = document.documentElement.dataset.theme;
      setTheme(saved === "light" || saved === "dark" ? saved : documentTheme === "light" ? "light" : "dark");
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("pa-theme", theme);
  }, [theme, ready]);

  return { theme, toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")), ready };
}
