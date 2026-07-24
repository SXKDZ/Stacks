"use client";

import { useCallback, useSyncExternalStore } from "react";

export type ThemeMode = "dark" | "light";

// A single module-level store so every useTheme() consumer in the document
// (topbar toggle, settings picker, feed toggle) shares one source of truth and
// re-renders together. Persisted to localStorage ("stacks-theme") and applied to
// <html data-theme>; a pre-hydration inline script in the layout sets the
// initial attribute to avoid a flash.
const listeners = new Set<() => void>();
let current: ThemeMode = "dark";
let initialized = false;

function readInitial(): ThemeMode {
  if (typeof document === "undefined") {
    return "dark";
  }
  const saved = window.localStorage.getItem("stacks-theme");
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function apply(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.localStorage.setItem("stacks-theme", theme);
}

function ensureInitialized() {
  if (!initialized && typeof document !== "undefined") {
    current = readInitial();
    apply(current);
    initialized = true;
    // Sync across windows/tabs: the `storage` event fires in OTHER documents
    // when localStorage changes here, so toggling the theme in the feed window
    // updates the main window (and vice versa) without a reload.
    window.addEventListener("storage", (event) => {
      if (event.key !== "stacks-theme") return;
      const next = event.newValue === "light" || event.newValue === "dark" ? event.newValue : null;
      if (!next || next === current) return;
      current = next;
      document.documentElement.dataset.theme = current;
      document.documentElement.style.colorScheme = current;
      listeners.forEach((listener) => listener());
    });
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
