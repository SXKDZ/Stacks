import { databasePath, ensureLibraryDirectories } from "./library-paths";
import { getLibraryDb, type LibraryDb } from "./client";

/**
 * Convenience accessor for the typed Drizzle handle over the local SQLite
 * library file. Most code obtains the handle through `ensureDatabase()` in
 * db/bootstrap.ts (which also runs schema init); use this when you only need a
 * handle and initialization has already happened.
 */
export function getDb(): LibraryDb {
  ensureLibraryDirectories();
  return getLibraryDb(databasePath());
}
