/**
 * runtime/src/storage/backup.ts
 *
 * Automatic backup before startup (design.md Decision 3, tech spec §51.3).
 * This is the first I/O step at Runtime startup: if `dbPath` exists, it is
 * copied to `<backupDir>/<timestamp>.sqlite` and verified with
 * `PRAGMA integrity_check` before migrations run. If anything fails, startup
 * must not proceed (`BackupFailedError`). No system time is read here — the
 * timestamp comes from the injected Clock.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NodeSqliteDriver } from './driver';

export class BackupFailedError extends Error {
  constructor(cause: unknown) {
    super(`BACKUP_FAILED: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'BackupFailedError';
    this.cause = cause;
  }
}

/** UTC `YYYYMMDDTHHmmssSSSZ`, per tech spec §51.3. */
export function formatBackupTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}Z`
  );
}

/** Side effects the backup step needs — injectable so failure modes are testable without relying on real file permissions. */
export interface BackupDeps {
  dbExists(): boolean;
  ensureDir(dir: string): void;
  fileExists(path: string): boolean;
  backupTo(destPath: string): void;
  verifyIntegrity(destPath: string): boolean;
}

/** Real filesystem / `NodeSqliteDriver`-backed implementation of `BackupDeps`. */
export function createNodeBackupDeps(dbPath: string): BackupDeps {
  return {
    dbExists: () => existsSync(dbPath),
    ensureDir: (dir: string) => {
      mkdirSync(dir, { recursive: true });
    },
    fileExists: (path: string) => existsSync(path),
    backupTo: (destPath: string) => {
      const source = new NodeSqliteDriver(dbPath);
      try {
        source.backupTo(destPath);
      } finally {
        source.close();
      }
    },
    verifyIntegrity: (destPath: string) => {
      const backup = new NodeSqliteDriver(destPath);
      try {
        const row = backup.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        return row.integrity_check === 'ok';
      } finally {
        backup.close();
      }
    },
  };
}

export interface BackupParams {
  dbPath: string;
  backupDir: string;
  clock: { now(): number };
  deps: BackupDeps;
}

/**
 * Returns the backup file path, or `null` on a fresh install (no existing
 * database — no backup is created). Throws `BackupFailedError` if the
 * database exists but the backup (directory creation, copy, or integrity
 * check) fails for any reason; the caller MUST NOT migrate or open the
 * database for writing in that case.
 */
export function backupBeforeStartup(params: BackupParams): string | null {
  const { dbPath, backupDir, clock, deps } = params;
  void dbPath;
  if (!deps.dbExists()) return null;

  try {
    deps.ensureDir(backupDir);
    const ts = formatBackupTimestamp(clock.now());
    let destPath = join(backupDir, `${ts}.sqlite`);
    let n = 0;
    while (deps.fileExists(destPath)) {
      n += 1;
      destPath = join(backupDir, `${ts}-${n}.sqlite`);
    }
    deps.backupTo(destPath);
    const ok = deps.verifyIntegrity(destPath);
    if (!ok) {
      throw new Error('backup failed PRAGMA integrity_check');
    }
    return destPath;
  } catch (err) {
    if (err instanceof BackupFailedError) throw err;
    throw new BackupFailedError(err);
  }
}
