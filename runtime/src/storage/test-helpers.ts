/**
 * runtime/src/storage/test-helpers.ts
 *
 * Shared test-only helpers for storage tests (hard invariant: tests use
 * in-memory or temp-dir DBs only, never a real file in `data/`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDriver } from './driver';

/** Opens a fresh `NodeSqliteDriver` backed by a temp-dir file (SQLite needs a real file for WAL). */
export function tmpDriver(): NodeSqliteDriver {
  const dir = mkdtempSync(join(tmpdir(), 'event-store-test-'));
  return new NodeSqliteDriver(join(dir, 'test.sqlite'));
}
