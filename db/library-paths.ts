import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Single source of truth for where the Paper Assistant library lives. The
 * library folder is the local, authoritative copy: it holds `library.db` (the
 * live SQLite database), `settings.json`, and the `pdfs/` and `html_snapshots/`
 * asset directories. OneDrive (if configured) receives a one-way backup of this
 * folder; it is never the live location. Resolution order:
 *   1. PA_LIBRARY_DIR environment variable
 *   2. libraryRoot in ~/.paperassistant/storage.json
 *   3. ~/.paperassistant/library (default local location)
 */

const storageConfigPath = join(homedir(), ".paperassistant", "storage.json");
const defaultLibraryRoot = join(homedir(), ".paperassistant", "library");

function expandLibraryPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return defaultLibraryRoot;
  }
  return trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : resolve(trimmed);
}

export function libraryRoot(): string {
  if (process.env.PA_LIBRARY_DIR?.trim()) {
    return expandLibraryPath(process.env.PA_LIBRARY_DIR);
  }
  if (existsSync(storageConfigPath)) {
    try {
      const stored = JSON.parse(readFileSync(storageConfigPath, "utf8")) as { libraryRoot?: string };
      if (stored.libraryRoot?.trim()) {
        return expandLibraryPath(stored.libraryRoot);
      }
    } catch {
      // A malformed optional preference must not prevent PA from starting.
    }
  }
  return defaultLibraryRoot;
}

export function databasePath(): string {
  return join(libraryRoot(), "library.db");
}

export function settingsPath(): string {
  return join(libraryRoot(), "settings.json");
}

/** Create the library folder and its asset subdirectories if missing. */
export function ensureLibraryDirectories(root = libraryRoot()): string {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "pdfs"), { recursive: true });
  mkdirSync(join(root, "html_snapshots"), { recursive: true });
  return root;
}
