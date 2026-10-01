/**
 * runtime/src/storage/driver.test.ts
 *
 * Task 1.1 spike + contract tests: confirms Vitest can load `node:sqlite`
 * and that `NodeSqliteDriver` satisfies the `SqliteDriver` contract
 * (openspec/changes/trading-event-store/specs/event-store/spec.md
 * "SQLite driver abstraction").
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AsyncTransactionError, NodeSqliteDriver } from './driver';

describe('node:sqlite spike', () => {
  it('loads node:sqlite and exposes DatabaseSync', async () => {
    const sqlite = await import('node:sqlite');
    expect(typeof sqlite.DatabaseSync).toBe('function');
  });
});

describe('NodeSqliteDriver', () => {
  let dir: string;
  let driver: NodeSqliteDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-driver-'));
    driver = new NodeSqliteDriver(join(dir, 'test.sqlite'));
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies WAL and foreign_keys pragmas on open', () => {
    const wal = driver.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(wal.journal_mode).toBe('wal');
    const fk = driver.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it('exec creates a table and prepare/run inserts a row', () => {
    driver.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    driver.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('a', 1);
    const row = driver.prepare('SELECT * FROM t WHERE id = ?').get('a') as { id: string; v: number };
    expect(row).toEqual({ id: 'a', v: 1 });
  });

  it('transaction rolls back and rethrows on error', () => {
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    expect(() =>
      driver.transaction(() => {
        driver.prepare('INSERT INTO trades (id) VALUES (?)').run('t1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const row = driver.prepare('SELECT * FROM trades WHERE id = ?').get('t1');
    expect(row).toBeUndefined();
  });

  it('transaction commits on success', () => {
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    driver.transaction(() => {
      driver.prepare('INSERT INTO trades (id) VALUES (?)').run('t1');
    });
    const row = driver.prepare('SELECT * FROM trades WHERE id = ?').get('t1');
    expect(row).toEqual({ id: 't1' });
  });

  it('nested transaction() calls join the outer transaction (reentrant)', () => {
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    driver.transaction(() => {
      driver.prepare('INSERT INTO trades (id) VALUES (?)').run('outer');
      driver.transaction(() => {
        driver.prepare('INSERT INTO trades (id) VALUES (?)').run('inner');
      });
    });
    const rows = driver.prepare('SELECT id FROM trades ORDER BY id').all();
    expect(rows).toEqual([{ id: 'inner' }, { id: 'outer' }]);
  });

  it('an error in a nested transaction() rolls back the entire outer transaction', () => {
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    expect(() =>
      driver.transaction(() => {
        driver.prepare('INSERT INTO trades (id) VALUES (?)').run('outer');
        driver.transaction(() => {
          throw new Error('inner failure');
        });
      }),
    ).toThrow('inner failure');
    const rows = driver.prepare('SELECT id FROM trades').all();
    expect(rows).toEqual([]);
  });

  it('rejects an async callback with AsyncTransactionError and rolls back', () => {
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    expect(() =>
      driver.transaction(() => {
        driver.prepare('INSERT INTO trades (id) VALUES (?)').run('t2');
        // deliberately return a Promise from a non-async arrow to simulate
        // an async callback without requiring `transaction`'s type to accept one
        return Promise.resolve() as unknown as void;
      }),
    ).toThrow(AsyncTransactionError);
    const row = driver.prepare('SELECT * FROM trades WHERE id = ?').get('t2');
    expect(row).toBeUndefined();
  });

  it('backupTo copies the database to a new file verifiable by a fresh driver', () => {
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    driver.prepare('INSERT INTO trades (id) VALUES (?)').run('t1');
    const backupPath = join(dir, 'backup.sqlite');
    driver.backupTo(backupPath);
    expect(existsSync(backupPath)).toBe(true);
    const backupDriver = new NodeSqliteDriver(backupPath);
    const row = backupDriver.prepare('SELECT * FROM trades WHERE id = ?').get('t1');
    expect(row).toEqual({ id: 't1' });
    backupDriver.close();
  });
});
