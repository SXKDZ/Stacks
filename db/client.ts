import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

/**
 * The single owner of the local SQLite connection. Stacks talks to its
 * `library.db` file through Drizzle (typed queries, automatic value coercion);
 * this module opens the underlying better-sqlite3 connection and hands out the
 * Drizzle handle. The database is a plain on-disk SQLite file.
 */

// The drizzle() return type includes `$client` (the raw better-sqlite3 handle)
// for the maintenance SQL that has no query-builder equivalent (PRAGMAs, DDL).
export type LibraryDb = ReturnType<typeof drizzle<typeof schema>>;

/** The Drizzle transaction handle passed to `db.transaction(tx => …)`. */
export type LibraryTx = Parameters<Parameters<LibraryDb["transaction"]>[0]>[0];

/** A handle that helpers can run queries on: either the db or an open tx. */
export type LibraryQuerier = LibraryDb | LibraryTx;

interface OpenConnection {
  file: string;
  raw: Database.Database;
  db: LibraryDb;
}

let connection: OpenConnection | null = null;

function openDatabase(file: string): OpenConnection {
  const raw = new Database(file);
  // TRUNCATE (not WAL) so no long-lived -wal/-shm sidecar files exist between
  // writes. The library folder is typically cloud-synced (OneDrive); a synced
  // WAL sidecar can be clobbered mid-write and corrupt the database. TRUNCATE
  // keeps the rollback journal transient and leaves a single .db file at rest.
  raw.pragma("journal_mode = TRUNCATE");
  raw.pragma("synchronous = FULL");
  raw.pragma("foreign_keys = ON");
  // Wait rather than fail immediately if another process holds a write lock
  // (e.g. the sync bridge taking a consistent snapshot).
  raw.pragma("busy_timeout = 5000");
  return { file, raw, db: drizzle(raw, { schema }) };
}

/**
 * Return the Drizzle handle for the given database file, reopening if the
 * resolved path changed since the last call (the library folder can be moved at
 * runtime — reusing a stale connection would silently read/write the old file).
 */
export function getLibraryDb(file: string): LibraryDb {
  if (connection && connection.file !== file) {
    connection.raw.close();
    connection = null;
  }
  if (!connection) {
    connection = openDatabase(file);
  }
  return connection.db;
}

/** The raw better-sqlite3 connection, for PRAGMAs, backups, and maintenance. */
export function getRawConnection(file: string): Database.Database {
  getLibraryDb(file);
  return connection!.raw;
}
