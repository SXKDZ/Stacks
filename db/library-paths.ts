import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Single source of truth for where the Stacks library lives. The library folder
 * is the local, authoritative copy: it holds `library.db` (the live SQLite
 * database), `settings.json`, and the `pdfs/` and `html_snapshots/` asset
 * directories. OneDrive (if configured) receives a one-way backup of this
 * folder; it is never the live location. Resolution order:
 *   1. STACKS_LIBRARY_DIR environment variable
 *   2. libraryRoot in ~/.stacks/storage.json
 *   3. ~/.stacks/library (default local location)
 */

const configDir = join(homedir(), ".stacks");
const storageConfigPath = join(configDir, "storage.json");
const defaultLibraryRoot = join(configDir, "library");

function expandLibraryPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return defaultLibraryRoot;
  }
  return trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : resolve(trimmed);
}

function readStoredRoot(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { libraryRoot?: string };
    return stored.libraryRoot?.trim() ? expandLibraryPath(stored.libraryRoot) : null;
  } catch {
    // A malformed optional preference must not prevent Stacks from starting.
    return null;
  }
}

export function libraryRoot(): string {
  const envDir = process.env.STACKS_LIBRARY_DIR?.trim();
  if (envDir) {
    return expandLibraryPath(envDir);
  }
  return readStoredRoot(storageConfigPath) ?? defaultLibraryRoot;
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

/**
 * Persist the library location to ~/.stacks/storage.json so the next
 * libraryRoot() resolves to `root`. Used when moving the library folder. Note:
 * STACKS_LIBRARY_DIR (if set) still wins over the stored value.
 */
export function setLibraryRoot(root: string): void {
  const resolved = resolve(root);
  mkdirSync(dirname(storageConfigPath), { recursive: true });
  writeFileSync(storageConfigPath, `${JSON.stringify({ libraryRoot: resolved }, null, 2)}\n`);
}
