import { drizzle } from "drizzle-orm/better-sqlite3";
import { databasePath, ensureLibraryDirectories } from "./library-paths";
import { getSqliteD1 } from "./sqlite-d1";
import * as schema from "./schema";

/**
 * Drizzle handle over the local SQLite library file. Most of the app talks to
 * the database through the raw D1-style adapter in db/bootstrap.ts; this
 * Drizzle export is available for typed query building if needed.
 */
export function getDb() {
  ensureLibraryDirectories();
  const adapter = getSqliteD1(databasePath());
  return drizzle(adapter.raw(), { schema });
}
