/**
 * runtime/test/scenarios/healthExchangeDisconnect.scenario.test.ts
 *
 * Task 4.3 — S10 (tech spec §42, "short exchange disconnected during
 * entry") reflected in Runtime Health (design.md Decision 3, healthModel.ts
 * task 3.1): when a TRADING exchange disconnects, `entry_allowed` flips to
 * `false` with an `EXCHANGE_DISCONNECTED:<exchange>` reason, and the
 * published Health row (read back exactly as `server.ts`'s `GET
 * /api/paper/health` would via `buildHealthApiPayload`) reflects it. This
 * is a distinct scenario from `S10.scenario.test.ts` (which exercises the
 * execution-layer REJECTED/EXCHANGE_DISCONNECTED -> CLOSED path) — here the
 * same underlying fact (an exchange is down) is checked at the
 * `runtime-health-reconciliation` capability's own layer: the Health model
 * and its SQLite-backed publish/read round trip. Real temp-dir SQLite/
 * `VirtualClock` — never a real exchange API or wall-clock sleep.
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { VirtualClock } from '../../src/clock/virtualClock';
import { deriveHealth, type ExchangeHealth } from '../../src/health/healthModel';
import { HealthPublisher, buildHealthApiPayload, readRuntimeHealthRow } from '../../src/health/healthPublisher';
import { migrate } from '../../src/storage/migrate';
import { migration001 } from '../../src/storage/migrations/001_initial';
import { migration002 } from '../../src/storage/migrations/002_position_accounting_fields';
import { migration003 } from '../../src/storage/migrations/003_runtime_health';
import { tmpDriver } from '../../src/storage/test-helpers';
import type { ExchangeId } from '../../src/types/ids';

describe('S10 exchange disconnect reflected in Health (tasks.md 4.3)', () => {
  it('a disconnected TRADING exchange blocks entry_allowed and is visible via GET /api/paper/health', () => {
    const db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
    const clock = new VirtualClock(1000);
    const publisher = new HealthPublisher({ db, clock });

    const longExchange = 'Binance' as ExchangeId;
    const shortExchange = 'Bybit' as ExchangeId;
    const exchanges: ExchangeHealth[] = [
      { exchange: longExchange, status: 'CONNECTED', stale: false, scanOnly: false },
      { exchange: shortExchange, status: 'DISCONNECTED', stale: false, scanOnly: false },
    ];

    const model = deriveHealth({
      engine: 'RUNNING',
      exchanges,
      scanner: 'RUNNING',
      risk: 'ARMED',
      paperExecution: 'ARMED',
      database: 'HEALTHY',
      clock: 'RELIABLE',
      credentials: 'PRESENT',
      entryHalted: false,
      haltReasons: [],
      lastEventAt: clock.now(),
    });

    expect(model.entry_allowed).toBe(false);
    expect(model.entry_block_reasons).toContain(`EXCHANGE_DISCONNECTED:${shortExchange}`);

    publisher.publish(model);
    clock.advanceTo(1500);

    // Exactly what `server.ts`'s GET /api/paper/health does: open a reader, build the payload.
    const row = readRuntimeHealthRow(db);
    const payload = buildHealthApiPayload(row, { nowMs: clock.now(), staleThresholdMs: 15_000 });

    expect(payload.engine).toBe('RUNNING');
    expect(payload.entry_allowed).toBe(false);
    expect(payload.entry_block_reasons).toContain(`EXCHANGE_DISCONNECTED:${shortExchange}`);
    expect(payload.exchanges).toEqual([
      { exchange: longExchange, status: 'CONNECTED' },
      { exchange: shortExchange, status: 'DISCONNECTED' },
    ]);
    // Invariant #2: never a credential value, only the status enum.
    expect(payload.credentials).toBe('PRESENT');

    assertTraceability(db);
    db.close();
  });

  it('a disconnected SCAN-ONLY exchange does not block entry and does not mark market_data STALE', () => {
    const db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
    const clock = new VirtualClock(0);
    const publisher = new HealthPublisher({ db, clock });

    const exchanges: ExchangeHealth[] = [
      { exchange: 'Binance' as ExchangeId, status: 'CONNECTED', stale: false, scanOnly: false },
      { exchange: 'OKX' as ExchangeId, status: 'DISCONNECTED', stale: true, scanOnly: true },
    ];

    const model = deriveHealth({
      engine: 'RUNNING',
      exchanges,
      scanner: 'RUNNING',
      risk: 'ARMED',
      paperExecution: 'ARMED',
      database: 'HEALTHY',
      clock: 'RELIABLE',
      credentials: 'PRESENT',
      entryHalted: false,
      haltReasons: [],
      lastEventAt: null,
    });

    expect(model.entry_allowed).toBe(true);
    expect(model.entry_block_reasons).toEqual([]);
    expect(model.marketData).toBe('HEALTHY');

    publisher.publish(model);
    const row = readRuntimeHealthRow(db);
    const payload = buildHealthApiPayload(row, { nowMs: clock.now(), staleThresholdMs: 15_000 });
    expect(payload.entry_allowed).toBe(true);

    assertTraceability(db);
    db.close();
  });
});
