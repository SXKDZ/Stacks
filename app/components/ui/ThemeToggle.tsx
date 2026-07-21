"use client";

import { Moon, Sun } from "lucide-react";
import { ActionButton } from "@/app/components/ui/controls";
import { useTheme } from "@/app/lib/use-theme";

/**
 * The single light/dark theme toggle used everywhere. Owns its own theme state
 * via useTheme, so any surface renders the identical control by dropping in
 * <ThemeToggle />; there is no per-page copy to drift.
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const label = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
  return (
    <ActionButton
      variant="secondary"
      size="icon"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      icon={theme === "dark" ? <Sun /> : <Moon />}
    />
  );
}
