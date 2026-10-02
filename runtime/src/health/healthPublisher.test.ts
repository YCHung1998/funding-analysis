/**
 * runtime/src/health/healthPublisher.test.ts
 *
 * Task 3.2 — `HealthPublisher` (write side: Runtime upserts `runtime_health`
 * via its own writable `SqliteDriver`) and the pure read-side helpers
 * `buildHealthApiPayload` / `buildReconciliationLatestPayload` that
 * `server.ts`'s two new read-only GET routes are thin wrappers over.
 * Design.md Decision 3: disconnected/unreachable -> `engine: 'UNREACHABLE'`;
 * the response never carries a real credential, only the `credentials`
 * `PRESENT | MISSING | INVALID` enum (Invariant #2, checked here with
 * `assertNoCredentials`). Real temp-dir SQLite DB + `VirtualClock`, never a
 * real exchange API or wall-clock sleep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import { NodeSqliteDriver } from '../storage/driver';
import { migrate } from '../storage/migrate';
import { migration001 } from '../storage/migrations/001_initial';
import { migration002 } from '../storage/migrations/002_position_accounting_fields';
import { migration003 } from '../storage/migrations/003_runtime_health';
import { tmpDriver } from '../storage/test-helpers';
import { assertNoCredentials } from '../types/validate';
import type { RuntimeHealthModel } from './healthModel';
import {
  buildHealthApiPayload,
  buildReconciliationLatestPayload,
  HealthPublisher,
  readLatestReconciliationRun,
  readRuntimeHealthRow,
  type ReaderDriver,
} from './healthPublisher';

const MODEL: RuntimeHealthModel = {
  engine: 'RUNNING',
  exchanges: [{ exchange: 'Binance', status: 'CONNECTED', stale: false, scanOnly: false }],
  marketData: 'HEALTHY',
  scanner: 'RUNNING',
  risk: 'ARMED',
  paperExecution: 'ARMED',
  database: 'HEALTHY',
  clock: 'RELIABLE',
  credentials: 'PRESENT',
  entry_allowed: true,
  entry_block_reasons: [],
  last_event_at: 500,
};

describe('HealthPublisher (write side)', () => {
  let db: NodeSqliteDriver;
  let clock: VirtualClock;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
    clock = new VirtualClock(1000);
  });

  afterEach(() => db.close());

  it('upserts the single runtime_health row (id=1) on every publish', () => {
    const publisher = new HealthPublisher({ db, clock });
    publisher.publish(MODEL);

    const row = readRuntimeHealthRow(db as unknown as ReaderDriver);
    expect(row).toBeDefined();
    expect(row?.entry_allowed).toBe(1);
    expect(row?.updated_at).toBe(1000);
    expect(JSON.parse(row!.components)).toMatchObject({ engine: 'RUNNING' });

    clock.advanceTo(2000);
    publisher.publish({ ...MODEL, entry_allowed: false, entry_block_reasons: ['ENTRY_HALT'] });
    const rows = db.prepare('SELECT * FROM runtime_health').all();
    expect(rows).toHaveLength(1); // still a single overwritten row
    const row2 = readRuntimeHealthRow(db as unknown as ReaderDriver);
    expect(row2?.entry_allowed).toBe(0);
    expect(row2?.updated_at).toBe(2000);
  });
});

describe('buildHealthApiPayload (design.md Decision 3)', () => {
  it('maps a fresh row into the API response shape, never leaking a credential', () => {
    const db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
    const clock = new VirtualClock(1000);
    new HealthPublisher({ db, clock }).publish(MODEL);
    const row = readRuntimeHealthRow(db as unknown as ReaderDriver);

    const payload = buildHealthApiPayload(row, { nowMs: 1500, staleThresholdMs: 6000 });
    expect(payload.engine).toBe('RUNNING');
    expect(payload.exchanges).toEqual([{ exchange: 'Binance', status: 'CONNECTED' }]);
    expect(payload.market_data).toBe('HEALTHY');
    expect(payload.scanner).toBe('RUNNING');
    expect(payload.risk_engine).toBe('ARMED');
    expect(payload.paper_execution).toBe('ARMED');
    expect(payload.database).toBe('HEALTHY');
    expect(payload.entry_allowed).toBe(true);
    expect(payload.entry_block_reasons).toEqual([]);
    expect(payload.credentials).toBe('PRESENT');
    expect(payload.runtime_heartbeat_at).toBe(1000);
    expect(payload.server_time).toBe(1500);

    expect(() => assertNoCredentials(payload, [])).not.toThrow();
    db.close();
  });

  it('returns engine: UNREACHABLE when no row exists yet', () => {
    const payload = buildHealthApiPayload(undefined, { nowMs: 1500, staleThresholdMs: 6000 });
    expect(payload.engine).toBe('UNREACHABLE');
    expect(payload.entry_allowed).toBe(false);
    expect(payload.entry_block_reasons).toContain('ENGINE_UNREACHABLE');
  });

  it('returns engine: UNREACHABLE when the row is older than 3x the publish interval (stale heartbeat)', () => {
    const db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
    const clock = new VirtualClock(1000);
    new HealthPublisher({ db, clock }).publish(MODEL);
    const row = readRuntimeHealthRow(db as unknown as ReaderDriver);

    // staleThresholdMs = 2000 (e.g. 3x a 666ms interval, simplified for the test); now is 4000 -> stale.
    const payload = buildHealthApiPayload(row, { nowMs: 4000, staleThresholdMs: 2000 });
    expect(payload.engine).toBe('UNREACHABLE');
    expect(payload.entry_allowed).toBe(false);
    db.close();
  });

  it('never includes a credentials field other than the PRESENT|MISSING|INVALID enum', () => {
    const payload = buildHealthApiPayload(undefined, { nowMs: 0, staleThresholdMs: 1000 });
    expect(['PRESENT', 'MISSING', 'INVALID']).toContain(payload.credentials);
  });
});

describe('readLatestReconciliationRun / buildReconciliationLatestPayload', () => {
  it('returns undefined / { run: null } when no reconciliation pass has ever run', () => {
    const db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
    const row = readLatestReconciliationRun(db as unknown as ReaderDriver);
    expect(row).toBeUndefined();
    expect(buildReconciliationLatestPayload(row)).toEqual({ run: null });
    db.close();
  });

  it('returns the most recent run with parsed mismatches', () => {
    const db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
    db.prepare(
      `INSERT INTO reconciliation_runs (run_id, started_at, completed_at, checks_run, mismatch_count, mismatches, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('r1', 1000, 1010, 5, 0, '[]', 1010, 1010);
    db.prepare(
      `INSERT INTO reconciliation_runs (run_id, started_at, completed_at, checks_run, mismatch_count, mismatches, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('r2', 2000, 2010, 5, 1, '[{"check_id":"ORDER_FILL_SUM","entity_id":"o1","trade_id":"t1","details":"x"}]', 2010, 2010);

    const row = readLatestReconciliationRun(db as unknown as ReaderDriver);
    expect(row?.run_id).toBe('r2');

    const payload = buildReconciliationLatestPayload(row);
    expect(payload.run?.run_id).toBe('r2');
    expect(payload.run?.mismatch_count).toBe(1);
    expect(payload.run?.mismatches).toEqual([{ check_id: 'ORDER_FILL_SUM', entity_id: 'o1', trade_id: 't1', details: 'x' }]);
    db.close();
  });
});
