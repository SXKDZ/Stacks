"use client";

import { useCallback, useSyncExternalStore } from "react";

export type ThemeMode = "dark" | "light";

// A single module-level store so every useTheme() consumer in the document
// (topbar toggle, settings picker, feed toggle) shares one source of truth and
// re-renders together. Persisted to localStorage ("pa-theme") and applied to
// <html data-theme>; a pre-hydration inline script in the layout sets the
// initial attribute to avoid a flash.
const listeners = new Set<() => void>();
let current: ThemeMode = "dark";
let initialized = false;

function readInitial(): ThemeMode {
  if (typeof document === "undefined") {
    return "dark";
  }
  const saved = window.localStorage.getItem("pa-theme");
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function apply(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.localStorage.setItem("pa-theme", theme);
}

function ensureInitialized() {
  if (!initialized && typeof document !== "undefined") {
    current = readInitial();
    apply(current);
    initialized = true;
  }
}

function setTheme(theme: ThemeMode) {
  ensureInitialized();
  if (theme === current) {
    return;
  }
  current = theme;
  apply(current);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): { theme: ThemeMode; setTheme: (theme: ThemeMode) => void; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, () => current, () => "dark" as ThemeMode);
  const toggleTheme = useCallback(() => setTheme(current === "dark" ? "light" : "dark"), []);
  return { theme, setTheme, toggleTheme };
}
