import Database from "better-sqlite3";
import type { Statement as BetterStatement } from "better-sqlite3";

/**
 * A minimal Cloudflare D1-compatible façade over the synchronous better-sqlite3
 * driver. It implements exactly the surface Paper Assistant uses — prepare /
 * bind / run / all (with `.results`) / first / batch — so the existing query
 * code in db/bootstrap.ts and app/api/library/route.ts runs unchanged against a
 * local `library.db` file. The D1 API is promise-based; better-sqlite3 is
 * synchronous, so results are wrapped in resolved promises.
 */

export interface D1RunResult {
  success: true;
  meta: { changes: number; last_row_id: number | bigint };
}

export interface D1AllResult<T> {
  results: T[];
  success: true;
}

export class SqlitePreparedStatement {
  private boundArgs: unknown[] = [];

  constructor(private readonly statement: BetterStatement, private readonly sql: string) {}

  bind(...args: unknown[]): SqlitePreparedStatement {
    const next = new SqlitePreparedStatement(this.statement, this.sql);
    next.boundArgs = args;
    return next;
  }

  private isReturning(): boolean {
    // better-sqlite3 requires .run() for statements that don't return rows and
    // .all()/.get() for those that do. We only ever call .all()/.first() on
    // SELECT/PRAGMA/RETURNING statements, so this heuristic is sufficient.
    return /^\s*(select|pragma|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
  }

  async run(): Promise<D1RunResult> {
    const info = this.statement.run(...(this.boundArgs as never[]));
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }

  async all<T = Record<string, unknown>>(): Promise<D1AllResult<T>> {
    const rows = this.statement.all(...(this.boundArgs as never[])) as T[];
    return { results: rows, success: true };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.statement.get(...(this.boundArgs as never[])) as T | undefined;
    return row ?? null;
  }

  /** Used internally by batch() to run within a transaction synchronously. */
  runSync(): void {
    this.statement.run(...(this.boundArgs as never[]));
  }
}

export class SqliteD1Database {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this.db.prepare(sql), sql);
  }

  /** Run prepared statements atomically, mirroring D1Database.batch(). */
  async batch(statements: SqlitePreparedStatement[]): Promise<D1RunResult[]> {
    const transaction = this.db.transaction((items: SqlitePreparedStatement[]) => {
      for (const item of items) {
        item.runSync();
      }
    });
    transaction(statements);
    return statements.map(() => ({ success: true as const, meta: { changes: 0, last_row_id: 0 } }));
  }

  /** Escape hatch for maintenance scripts; not part of the D1 surface. */
  raw(): Database.Database {
    return this.db;
  }
}

/** Aliases so call sites can keep D1-style names while using this adapter. */
export type LibraryDatabase = SqliteD1Database;
export type LibraryStatement = SqlitePreparedStatement;

let instance: SqliteD1Database | null = null;

export function getSqliteD1(databaseFile: string): SqliteD1Database {
  if (!instance) {
    const database = new Database(databaseFile);
    // TRUNCATE (not WAL) so no long-lived -wal/-shm sidecar files exist between
    // writes. The library folder is typically cloud-synced (OneDrive); a synced
    // WAL sidecar can be clobbered mid-write and corrupt the database. TRUNCATE
    // keeps the rollback journal transient and leaves a single .db file at rest.
    database.pragma("journal_mode = TRUNCATE");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    instance = new SqliteD1Database(database);
  }
  return instance;
}
