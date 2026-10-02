/**
 * runtime/src/storage/migrate.ts
 *
 * Reversible migration framework (design.md Decision 2 / spec "Reversible
 * migrations"). Each migration is a numbered `{ version, name, up, down }`
 * applied inside its own transaction; `schema_migrations` records what has
 * been applied. No system time is used here — `applied_at` is supplied by
 * the caller via an injected clock-like `{ now(): number }`, defaulting to a
 * fixed `0` so the framework itself never touches wall-clock time (runtime
 * callers must pass a real `Clock`).
 */
import type { SqliteDriver } from './driver';

export interface Migration {
  version: number;
  name: string;
  up(db: SqliteDriver): void;
  down(db: SqliteDriver): void;
}

export interface MigrationClock {
  now(): number;
}

const ZERO_CLOCK: MigrationClock = { now: () => 0 };

export class MigrationError extends Error {
  constructor(
    public readonly migrationName: string,
    cause: unknown,
  ) {
    super(`Migration ${migrationName} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
    this.cause = cause;
  }
}

function ensureMigrationsTable(db: SqliteDriver): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
  );
}

/** Highest applied migration version, or 0 if none have been applied. */
export function currentVersion(db: SqliteDriver): number {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/**
 * Applies pending `up` migrations in ascending version order, up to and
 * including `target` (default: all). Each migration runs in its own
 * transaction; a thrown error rolls that migration back (nothing it created
 * persists, `schema_migrations` stays at the previous version) and is
 * rethrown wrapped as `MigrationError`. Calling `migrate` again with no new
 * pending migrations is a no-op (idempotent).
 */
export function migrate(
  db: SqliteDriver,
  migrations: readonly Migration[],
  target: number = Infinity,
  clock: MigrationClock = ZERO_CLOCK,
): void {
  ensureMigrationsTable(db);
  const applied = currentVersion(db);
  const pending = [...migrations].filter((m) => m.version > applied && m.version <= target).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    try {
      db.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          clock.now(),
        );
      });
    } catch (err) {
      throw new MigrationError(m.name, err);
    }
  }
}

/**
 * Applies `down` migrations in descending version order, down to (but not
 * including) `target`. Each migration runs in its own transaction.
 */
export function rollback(db: SqliteDriver, migrations: readonly Migration[], target: number): void {
  ensureMigrationsTable(db);
  const applied = currentVersion(db);
  const toRollback = [...migrations].filter((m) => m.version > target && m.version <= applied).sort((a, b) => b.version - a.version);
  for (const m of toRollback) {
    try {
      db.transaction(() => {
        m.down(db);
        db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(m.version);
      });
    } catch (err) {
      throw new MigrationError(m.name, err);
    }
  }
}
