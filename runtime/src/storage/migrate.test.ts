/**
 * runtime/src/storage/migrate.test.ts
 *
 * Task 1.2 — migration framework round-trip and failure-recovery tests
 * (spec "Reversible migrations").
 */
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from './driver';
import { currentVersion, migrate, MigrationError, rollback, type Migration } from './migrate';
import { tmpDriver } from './test-helpers';

function schemaSql(db: NodeSqliteDriver): string[] {
  return (
    db.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as {
      sql: string;
    }[]
  )
    .map((r) => r.sql)
    .sort();
}

const m1: Migration = {
  version: 1,
  name: '001_create_widgets',
  up(db) {
    db.exec('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  },
  down(db) {
    db.exec('DROP TABLE widgets');
  },
};

const m2: Migration = {
  version: 2,
  name: '002_create_gadgets',
  up(db) {
    db.exec('CREATE TABLE gadgets (id TEXT PRIMARY KEY)');
  },
  down(db) {
    db.exec('DROP TABLE gadgets');
  },
};

const mFailing: Migration = {
  version: 2,
  name: '002_broken',
  up() {
    throw new Error('deliberate failure');
  },
  down() {
    /* never reached */
  },
};

describe('migrate / rollback', () => {
  it('applies pending migrations in ascending order, recording schema_migrations', () => {
    const db = tmpDriver();
    migrate(db, [m1, m2]);
    expect(currentVersion(db)).toBe(2);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual([
      { version: 1, name: '001_create_widgets' },
      { version: 2, name: '002_create_gadgets' },
    ]);
  });

  it('round trip is lossless for schema: up, down to 0, up again', () => {
    const db = tmpDriver();
    migrate(db, [m1, m2]);
    const afterFirstUp = schemaSql(db);
    rollback(db, [m1, m2], 0);
    expect(currentVersion(db)).toBe(0);
    migrate(db, [m1, m2]);
    expect(schemaSql(db)).toEqual(afterFirstUp);
  });

  it('failed migration leaves previous version, no partial objects, and names the migration', () => {
    const db = tmpDriver();
    migrate(db, [m1]);
    expect(() => migrate(db, [m1, mFailing])).toThrow(MigrationError);
    expect(currentVersion(db)).toBe(1);
    expect(() => db.prepare('SELECT * FROM gadgets').all()).toThrow();
    try {
      migrate(db, [m1, mFailing]);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).migrationName).toBe('002_broken');
    }
  });

  it('is idempotent: calling migrate twice applies nothing the second time', () => {
    const db = tmpDriver();
    migrate(db, [m1, m2]);
    migrate(db, [m1, m2]);
    const rows = db.prepare('SELECT version FROM schema_migrations').all();
    expect(rows).toHaveLength(2);
  });

  it('each migration runs in its own transaction (rollback of m2 does not touch m1 data)', () => {
    const db = tmpDriver();
    migrate(db, [m1]);
    db.prepare('INSERT INTO widgets (id, name) VALUES (?, ?)').run('w1', 'Widget');
    migrate(db, [m1, m2]);
    const row = db.prepare('SELECT * FROM widgets WHERE id = ?').get('w1');
    expect(row).toEqual({ id: 'w1', name: 'Widget' });
  });
});
