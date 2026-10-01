/**
 * runtime/src/storage/driver.ts
 *
 * `SqliteDriver` — thin interface isolating the rest of the runtime from the
 * concrete SQLite library (design.md Decision 1). `NodeSqliteDriver` is the
 * default implementation on `node:sqlite` `DatabaseSync`. The Runtime process
 * is the only writer (C-06) — this driver never opens a remote connection.
 */
import { DatabaseSync } from 'node:sqlite';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * Thin SQLite access interface (design.md §7). `transaction(fn)` runs `fn`
 * synchronously between `BEGIN IMMEDIATE` and `COMMIT`; any thrown error, or
 * `fn` returning a `Promise` (disallowed — the whole point of a synchronous
 * driver is that one transaction can never interleave with another event),
 * rolls back and rethrows.
 */
export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: () => T): T;
  backupTo(path: string): void;
  close(): void;
}

/** Thrown when `transaction(fn)` is given a callback that returns a `Promise`. */
export class AsyncTransactionError extends Error {
  constructor() {
    super('SqliteDriver.transaction: callback must be synchronous (returned a Promise)');
    this.name = 'AsyncTransactionError';
  }
}

export class NodeSqliteDriver implements SqliteDriver {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => stmt.run(...(params as never[])) as unknown as RunResult,
      get: (...params: unknown[]) => stmt.get(...(params as never[])),
      all: (...params: unknown[]) => stmt.all(...(params as never[])),
    };
  }

  /**
   * Reentrant: a `transaction(fn)` call nested inside another (e.g. a
   * repository's own `transaction` used from within `Ledger`'s) joins the
   * outer transaction instead of issuing a nested `BEGIN` (SQLite has no
   * nested transactions without savepoints). Only the outermost call issues
   * `BEGIN IMMEDIATE` / `COMMIT`; any error at any depth rolls back the
   * whole outer transaction.
   */
  transaction<T>(fn: () => T): T {
    const isOutermost = this.transactionDepth === 0;
    if (isOutermost) this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.transactionDepth -= 1;
      if (isOutermost) this.db.exec('ROLLBACK');
      throw err;
    }
    this.transactionDepth -= 1;
    if (result instanceof Promise) {
      if (isOutermost) this.db.exec('ROLLBACK');
      throw new AsyncTransactionError();
    }
    if (isOutermost) this.db.exec('COMMIT');
    return result;
  }

  backupTo(path: string): void {
    // node:sqlite's `backup()` free function is async (returns a Promise);
    // `SqliteDriver.backupTo` must be synchronous (one DB transaction per
    // tick invariant — design.md Decision 1). `VACUUM INTO` performs an
    // equivalent online-consistent copy synchronously.
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.db.close();
  }
}
