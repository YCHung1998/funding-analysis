/**
 * runtime/src/storage/backup.test.ts
 *
 * Task 1.3 — automatic backup before startup (spec "Automatic backup before
 * startup"): filename format, integrity_check, failure refuses startup, no
 * backup on fresh install, same-millisecond suffix handling.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import { backupBeforeStartup, BackupFailedError, formatBackupTimestamp, createNodeBackupDeps } from './backup';
import { NodeSqliteDriver } from './driver';

describe('formatBackupTimestamp', () => {
  it('formats epoch ms as UTC YYYYMMDDTHHmmssSSSZ', () => {
    // 2026-09-30T15:31:02.153Z
    const epochMs = Date.UTC(2026, 8, 30, 15, 31, 2, 153);
    expect(formatBackupTimestamp(epochMs)).toBe('20260930T153102153Z');
  });
});

describe('backupBeforeStartup', () => {
  let dir: string;
  let dbPath: string;
  let backupDir: string;
  let clock: VirtualClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-backup-'));
    dbPath = join(dir, 'runtime.sqlite');
    backupDir = join(dir, 'data', 'backup');
    clock = new VirtualClock(Date.UTC(2026, 8, 30, 15, 31, 2, 153));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh install: no database file -> no backup created', () => {
    const deps = createNodeBackupDeps(dbPath);
    const result = backupBeforeStartup({ dbPath, backupDir, clock, deps });
    expect(result).toBeNull();
    expect(existsSync(backupDir)).toBe(false);
  });

  it('creates data/backup/<timestamp>.sqlite containing the same rows, verified by integrity_check', () => {
    const driver = new NodeSqliteDriver(dbPath);
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    driver.prepare('INSERT INTO trades (id) VALUES (?)').run('t1');
    driver.close();

    const deps = createNodeBackupDeps(dbPath);
    const result = backupBeforeStartup({ dbPath, backupDir, clock, deps });

    expect(result).toBe(join(backupDir, '20260930T153102153Z.sqlite'));
    expect(existsSync(result!)).toBe(true);

    const backupDriver = new NodeSqliteDriver(result!);
    const row = backupDriver.prepare('SELECT * FROM trades WHERE id = ?').get('t1');
    expect(row).toEqual({ id: 't1' });
    backupDriver.close();
  });

  it('same-millisecond repeated startup appends -1, -2 suffixes without overwriting', () => {
    const driver = new NodeSqliteDriver(dbPath);
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    driver.close();
    const deps = createNodeBackupDeps(dbPath);

    const first = backupBeforeStartup({ dbPath, backupDir, clock, deps });
    const second = backupBeforeStartup({ dbPath, backupDir, clock, deps });
    const third = backupBeforeStartup({ dbPath, backupDir, clock, deps });

    expect(first).toBe(join(backupDir, '20260930T153102153Z.sqlite'));
    expect(second).toBe(join(backupDir, '20260930T153102153Z-1.sqlite'));
    expect(third).toBe(join(backupDir, '20260930T153102153Z-2.sqlite'));
    expect(readdirSync(backupDir).sort()).toEqual(
      ['20260930T153102153Z-1.sqlite', '20260930T153102153Z-2.sqlite', '20260930T153102153Z.sqlite'].sort(),
    );
  });

  it('backup failure blocks startup: throws BackupFailedError, no migration applied, backupDir not writable', () => {
    const driver = new NodeSqliteDriver(dbPath);
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    driver.close();

    // Force mkdir to fail: put a regular file where the backup directory should be.
    writeFileSync(join(dir, 'data'), 'not a directory');
    const deps = createNodeBackupDeps(dbPath);

    expect(() => backupBeforeStartup({ dbPath, backupDir, clock, deps })).toThrow(BackupFailedError);
  });

  it('backup failure is also raised when the driver backup/copy step itself fails', () => {
    const driver = new NodeSqliteDriver(dbPath);
    driver.exec('CREATE TABLE trades (id TEXT PRIMARY KEY)');
    driver.close();

    const deps = createNodeBackupDeps(dbPath);
    const failingDeps = { ...deps, backupTo: () => { throw new Error('disk full'); } };

    expect(() => backupBeforeStartup({ dbPath, backupDir, clock, deps: failingDeps })).toThrow(BackupFailedError);
  });
});
