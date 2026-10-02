/**
 * runtime/src/health/healthPublisher.ts
 *
 * `HealthPublisher` (write side, Runtime process, task 3.2): upserts the
 * single `runtime_health` row (design.md Decision 3 — Health is a state
 * cache, not a `TradingEvent`). The read side (`buildHealthApiPayload` /
 * `buildReconciliationLatestPayload` / `readRuntimeHealthRow` /
 * `readLatestReconciliationRun`) is deliberately pure / reader-interface
 * based so it can be unit-tested without a real `node:sqlite` `readOnly`
 * connection — `server.ts` supplies that connection (via
 * `new DatabaseSync(path, { readOnly: true })`, design.md Decision 3) and
 * calls these functions.
 *
 * Disconnected/unreachable (no row yet, or the row's `updated_at` is older
 * than the caller's staleness threshold — design.md Decision 3 "失聯判斷只需
 * 比對 updated_at"; 3x the publish interval, per design.md "失聯閾值 3 倍間隔
 * 吸收兩者偏差") -> `engine: 'UNREACHABLE'`. The response body only ever
 * carries `credentials: 'PRESENT' | 'MISSING' | 'INVALID'` (Invariant #2) —
 * never a real credential value.
 */
import type { SqliteDriver } from '../storage/driver';
import type { ExchangeId } from '../types/ids';
import { assertNoCredentials } from '../types/validate';
import type { RuntimeHealthModel } from './healthModel';

export interface HealthPublisherClock {
  now(): number;
}

export interface HealthPublisherDeps {
  db: SqliteDriver;
  clock: HealthPublisherClock;
}

/** Runtime-side: upserts `runtime_health(id=1)` (design.md Decision 3). */
export class HealthPublisher {
  constructor(private readonly deps: HealthPublisherDeps) {}

  publish(model: RuntimeHealthModel): void {
    const now = this.deps.clock.now();
    this.deps.db
      .prepare(
        `INSERT INTO runtime_health (id, components, entry_allowed, entry_block_reasons, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           components = excluded.components,
           entry_allowed = excluded.entry_allowed,
           entry_block_reasons = excluded.entry_block_reasons,
           updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(model), model.entry_allowed ? 1 : 0, JSON.stringify(model.entry_block_reasons), now);
  }
}

// ---------------------------------------------------------------------------
// Read side — reader-interface based (works with any `{prepare}` driver,
// including a `node:sqlite` `DatabaseSync` opened `{ readOnly: true }`).
// ---------------------------------------------------------------------------

export interface ReaderStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The minimal read-only surface `server.ts`'s `DatabaseSync(path, { readOnly: true })` provides. */
export interface ReaderDriver {
  prepare(sql: string): ReaderStatement;
}

export interface RuntimeHealthRow {
  id: number;
  components: string;
  entry_allowed: number;
  entry_block_reasons: string;
  updated_at: number;
}

export function readRuntimeHealthRow(reader: ReaderDriver): RuntimeHealthRow | undefined {
  return reader.prepare('SELECT * FROM runtime_health WHERE id = 1').get() as RuntimeHealthRow | undefined;
}

export interface ReconciliationRunRow {
  run_id: string;
  started_at: number;
  completed_at: number;
  checks_run: number;
  mismatch_count: number;
  mismatches: string;
  created_at: number;
  updated_at: number;
}

export function readLatestReconciliationRun(reader: ReaderDriver): ReconciliationRunRow | undefined {
  return reader.prepare('SELECT * FROM reconciliation_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get() as
    | ReconciliationRunRow
    | undefined;
}

// ---------------------------------------------------------------------------
// `GET /api/paper/health` payload (design.md Decision 3; proposal.md "What
// Changes" 2026-10-03 rename note). The shape is a superset of the
// already-merged `paper-trading-ui` frontend's `RuntimeHealth` contract
// (`src/features/paperTrading/api/contracts.ts`) — every field that contract
// reads (`engine`, `exchanges[]`, `market_data`, `scanner`, `risk_engine`,
// `paper_execution`, `database`, `last_event_at`, `runtime_heartbeat_at`,
// `server_time`) is present with the same name/shape, so the existing
// frontend keeps working unmodified; this change additively includes its own
// `entry_allowed` / `entry_block_reasons` / `clock` / `credentials` fields on
// top (see design.md Implementation Notes "task 3.2 health 回應形狀").
// ---------------------------------------------------------------------------

export interface HealthApiPayload {
  engine: string;
  exchanges: Array<{ exchange: ExchangeId; status: string }>;
  market_data: string;
  scanner: string;
  risk_engine: string;
  paper_execution: string;
  database: string;
  last_event_at: number | null;
  runtime_heartbeat_at: number;
  server_time: number;
  clock: string;
  credentials: 'PRESENT' | 'MISSING' | 'INVALID';
  entry_allowed: boolean;
  entry_block_reasons: string[];
}

const UNREACHABLE_PAYLOAD_BASE = {
  engine: 'UNREACHABLE',
  exchanges: [] as Array<{ exchange: ExchangeId; status: string }>,
  market_data: 'UNKNOWN',
  scanner: 'UNKNOWN',
  risk_engine: 'UNKNOWN',
  paper_execution: 'UNKNOWN',
  database: 'UNKNOWN',
  clock: 'UNRELIABLE',
  credentials: 'MISSING' as const,
  entry_allowed: false,
  entry_block_reasons: ['ENGINE_UNREACHABLE'],
};

export function buildHealthApiPayload(
  row: RuntimeHealthRow | undefined,
  opts: { nowMs: number; staleThresholdMs: number },
): HealthApiPayload {
  if (!row || opts.nowMs - row.updated_at > opts.staleThresholdMs) {
    const payload: HealthApiPayload = {
      ...UNREACHABLE_PAYLOAD_BASE,
      last_event_at: null,
      runtime_heartbeat_at: row?.updated_at ?? 0,
      server_time: opts.nowMs,
    };
    assertNoCredentials(payload, []);
    return payload;
  }

  const model = JSON.parse(row.components) as RuntimeHealthModel;
  const payload: HealthApiPayload = {
    engine: model.engine,
    exchanges: model.exchanges.map((e) => ({ exchange: e.exchange, status: e.status })),
    market_data: model.marketData,
    scanner: model.scanner,
    risk_engine: model.risk,
    paper_execution: model.paperExecution,
    database: model.database,
    last_event_at: model.last_event_at,
    runtime_heartbeat_at: row.updated_at,
    server_time: opts.nowMs,
    clock: model.clock,
    credentials: model.credentials,
    entry_allowed: row.entry_allowed === 1,
    entry_block_reasons: JSON.parse(row.entry_block_reasons) as string[],
  };
  assertNoCredentials(payload, []);
  return payload;
}

// ---------------------------------------------------------------------------
// `GET /api/runtime/reconciliation/latest` payload (internal/ops, not a UI contract).
// ---------------------------------------------------------------------------

export interface ReconciliationLatestPayload {
  run: {
    run_id: string;
    started_at: number;
    completed_at: number;
    checks_run: number;
    mismatch_count: number;
    mismatches: unknown[];
  } | null;
}

export function buildReconciliationLatestPayload(row: ReconciliationRunRow | undefined): ReconciliationLatestPayload {
  if (!row) return { run: null };
  return {
    run: {
      run_id: row.run_id,
      started_at: row.started_at,
      completed_at: row.completed_at,
      checks_run: row.checks_run,
      mismatch_count: row.mismatch_count,
      mismatches: JSON.parse(row.mismatches) as unknown[],
    },
  };
}
