/**
 * runtime/test/scenarios/serverRuntimeIndependence.scenario.test.ts
 *
 * Task 4.3 — "server.ts 重啟不影響 Runtime process" (✅ C-06, tech spec
 * §48.4). `server.ts`'s two GET routes each open a brand-new
 * `new DatabaseSync(path, { readOnly: true })` per request and close it
 * immediately after (task 3.2) — this scenario proves that pattern cannot
 * affect the Runtime's own writer connection: opening and closing many
 * independent read-only connections to the SAME file, interleaved with the
 * Runtime continuing to write (Ledger transitions, Health publishes),
 * never blocks or corrupts either side. A real temp-dir SQLite FILE (not
 * `:memory:` — this scenario is specifically about one on-disk file shared
 * by two independent connections) + `VirtualClock`; never a real exchange
 * API or wall-clock sleep.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { VirtualClock } from '../../src/clock/virtualClock';
import { createAccountRepository } from '../../src/storage/accountRepository';
import { NodeSqliteDriver } from '../../src/storage/driver';
import { EventStore } from '../../src/storage/eventStore';
import { Ledger } from '../../src/storage/ledger';
import { migrate } from '../../src/storage/migrate';
import { migration001 } from '../../src/storage/migrations/001_initial';
import { migration002 } from '../../src/storage/migrations/002_position_accounting_fields';
import { migration003 } from '../../src/storage/migrations/003_runtime_health';
import { createOrderRepository } from '../../src/storage/orderRepository';
import { createTradeRepository } from '../../src/storage/tradeRepository';
import { HealthPublisher, readRuntimeHealthRow, buildHealthApiPayload } from '../../src/health/healthPublisher';
import { deriveHealth } from '../../src/health/healthModel';
import type { AccountSnapshot, Trade } from '../../src/types';

/** Mirrors `server.ts`'s per-request pattern exactly: open readOnly, read, close. */
function readHealthLikeServerDoes(dbPath: string, nowMs: number) {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = readRuntimeHealthRow(reader);
    return buildHealthApiPayload(row, { nowMs, staleThresholdMs: 15_000 });
  } finally {
    reader.close();
  }
}

describe('server.ts restart does not affect the Runtime process (tasks.md 4.3, C-06)', () => {
  it('many independent readOnly connections opening/closing never block or corrupt the Runtime writer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'server-runtime-independence-'));
    const dbPath = join(dir, 'paper.sqlite');

    // --- "Runtime process" ---
    const db = new NodeSqliteDriver(dbPath);
    migrate(db, [migration001, migration002, migration003]);
    const clock = new VirtualClock(0);
    const trade = createTradeRepository(db);
    const order = createOrderRepository(db);
    const account = createAccountRepository(db);
    const eventStore = new EventStore(db, clock);
    const ledger = new Ledger(db, clock, { trade, order, account }, eventStore);
    const healthPublisher = new HealthPublisher({ db, clock });

    const initial: AccountSnapshot = {
      snapshot_id: 'init',
      mode: 'PAPER',
      snapshot_time: 0,
      total_capital_usdt: 10_000,
      reserved_capital_usdt: 0,
      available_capital_usdt: 10_000,
      used_margin_usdt: 0,
      realized_pnl_usdt: 0,
      open_trade_count: 0,
      reason: 'INITIAL',
      config_version: 'c1',
      created_at: 0,
      updated_at: 0,
    };
    account.saveAccountSnapshot(initial);

    healthPublisher.publish(
      deriveHealth({
        engine: 'RUNNING',
        exchanges: [],
        scanner: 'RUNNING',
        risk: 'ARMED',
        paperExecution: 'ARMED',
        database: 'HEALTHY',
        clock: 'RELIABLE',
        credentials: 'PRESENT',
        entryHalted: false,
        haltReasons: [],
        lastEventAt: clock.now(),
      }),
    );

    // --- "server.ts" instance #1 reads, then its process restarts (connection closed) ---
    const payload1 = readHealthLikeServerDoes(dbPath, clock.now());
    expect(payload1.engine).toBe('RUNNING');

    // The Runtime keeps writing — unaffected by the server connection's lifecycle.
    const tr: Trade = {
      trade_id: 't1',
      opportunity_id: 'opp1',
      strategy_id: 's1',
      strategy_version: 'v1',
      config_version: 'c1',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      created_at: clock.now(),
      updated_at: clock.now(),
      status: 'CREATED',
      target_notional_per_leg_usdt: 1000,
      leverage: 1,
      allocated_margin_usdt: 1000,
      allocated_capital_usdt: 2000,
      legs: [],
      expected_pnl_usdt: 1,
      risk_status: {
        overall_status: 'PASS',
        checks: [],
        failed_reasons: [],
        leg_imbalance_detected: false,
        action_recommendation: 'PROCEED_TRADE',
      },
    };
    trade.saveOpportunity({
      opportunity_id: 'opp1',
      symbol: 'BTCUSDT',
      created_at: 0,
      detected_at: 0,
      expires_at: 1_000_000,
      updated_at: 0,
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      long_funding_rate: 0.0001,
      short_funding_rate: 0.0002,
      funding_spread: 0.0001,
      long_funding_time: 1,
      short_funding_time: 1,
      long_funding_interval_hours: 8,
      short_funding_interval_hours: 8,
      funding_time_diff_ms: 0,
      funding_aligned: true,
      long_price: 100,
      short_price: 100.1,
      price_difference_pct: 0.001,
      estimated_fee_pct: 0.0005,
      estimated_slippage_pct: 0.0005,
      estimated_funding_pnl: 1,
      estimated_net_pnl: 0.5,
      liquidity_score: 0.9,
      strategy_version: 'v1',
      status: 'SELECTED',
    });
    ledger.reserveCapitalAndCreateTrade(tr, 2000);

    clock.advanceTo(5000);
    healthPublisher.publish(
      deriveHealth({
        engine: 'RUNNING',
        exchanges: [],
        scanner: 'RUNNING',
        risk: 'ARMED',
        paperExecution: 'ARMED',
        database: 'HEALTHY',
        clock: 'RELIABLE',
        credentials: 'PRESENT',
        entryHalted: false,
        haltReasons: [],
        lastEventAt: clock.now(),
      }),
    );

    // --- "server.ts" instance #2, post-restart — opens a brand-new connection, sees the continued Runtime state ---
    const payload2 = readHealthLikeServerDoes(dbPath, clock.now());
    expect(payload2.runtime_heartbeat_at).toBe(5000);
    expect(payload2.entry_allowed).toBe(true);

    // The trade the Runtime wrote in between is visible and intact from the Runtime's own connection.
    expect(trade.getTrade('t1')!.status).toBe('CREATED');

    // A third, concurrent readOnly connection while the Runtime continues to hold its writer open.
    const reader3 = new DatabaseSync(dbPath, { readOnly: true });
    const stillThere = readRuntimeHealthRow(reader3);
    expect(stillThere).toBeDefined();
    reader3.close();

    assertTraceability(db);
    db.close();
  });
});
