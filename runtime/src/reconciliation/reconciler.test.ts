/**
 * runtime/src/reconciliation/reconciler.test.ts
 *
 * Task 2.3 — `Reconciler`: Clock-scheduled runs, a consistent-snapshot read
 * (one DB transaction per pass — a failure mid-pass rolls back everything,
 * including the `reconciliation_runs` row itself), a `reconciliation_runs`
 * record on every pass, `RECONCILIATION_ERROR` events (deduplicated), the
 * affected Trade transitioning to `FAILED` (with capital released in the
 * same transaction), `EntryHaltPort.requestHalt` being called, and — the
 * explicit non-goal — never touching orders or positions (no cancel, no
 * close). Real `Ledger` / `EventStore` / temp-dir SQLite DB / `VirtualClock`,
 * never a real exchange API or wall-clock sleep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, Trade, TradeLeg } from '../types';
import type { ExchangeId } from '../types/ids';
import { VirtualClock } from '../clock/virtualClock';
import { createAccountRepository } from '../storage/accountRepository';
import { NodeSqliteDriver } from '../storage/driver';
import { EventStore } from '../storage/eventStore';
import { Ledger, type LedgerRepos } from '../storage/ledger';
import { migrate } from '../storage/migrate';
import { migration001 } from '../storage/migrations/001_initial';
import { migration002 } from '../storage/migrations/002_position_accounting_fields';
import { migration003 } from '../storage/migrations/003_runtime_health';
import { createOrderRepository } from '../storage/orderRepository';
import { createTradeRepository } from '../storage/tradeRepository';
import { tmpDriver } from '../storage/test-helpers';
import { EntryHaltLatch } from './entryHalt';
import { Reconciler } from './reconciler';
import { DEFAULT_RECONCILIATION_CONFIG } from './types';

const RISK_PASS = {
  overall_status: 'PASS' as const,
  checks: [],
  failed_reasons: [],
  leg_imbalance_detected: false,
  action_recommendation: 'PROCEED_TRADE' as const,
};

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    trade_id: 't1',
    opportunity_id: 'opp1',
    strategy_id: 's1',
    strategy_version: 'v1',
    config_version: 'c1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    created_at: 1,
    updated_at: 1,
    status: 'ENTRY_PENDING',
    target_notional_per_leg_usdt: 100_000,
    leverage: 1,
    allocated_margin_usdt: 1000,
    allocated_capital_usdt: 1000,
    legs: [],
    expected_pnl_usdt: 0,
    risk_status: RISK_PASS,
    ...overrides,
  };
}

function makeLeg(overrides: Partial<TradeLeg> = {}): TradeLeg {
  return {
    leg_id: 'l1',
    trade_id: 't1',
    exchange: EX,
    symbol: 'BTCUSDT',
    direction: 'LONG',
    order_side: 'BUY',
    leverage: 1,
    target_notional_usdt: 100_000,
    target_quantity: 1000,
    margin_allocated_usdt: 1000,
    target_entry_price: 100,
    entry_order_ids: [],
    exit_order_ids: [],
    status: 'OPENING',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

const EX: ExchangeId = 'Binance';

describe('Reconciler (design.md Decision 1/2, task 2.3)', () => {
  let db: NodeSqliteDriver;
  let clock: VirtualClock;
  let repos: LedgerRepos;
  let eventStore: EventStore;
  let ledger: Ledger;
  let entryHalt: EntryHaltLatch;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
    clock = new VirtualClock(1000);
    repos = {
      trade: createTradeRepository(db),
      order: createOrderRepository(db),
      account: createAccountRepository(db),
    };
    eventStore = new EventStore(db, clock);
    ledger = new Ledger(db, clock, repos, eventStore);
    entryHalt = new EntryHaltLatch(eventStore, clock);

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
    repos.account.saveAccountSnapshot(initial);

    repos.trade.saveOpportunity({
      opportunity_id: 'opp1',
      symbol: 'BTCUSDT',
      created_at: 1,
      detected_at: 1,
      expires_at: 2,
      updated_at: 1,
      long_exchange: EX,
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
  });

  afterEach(() => {
    db.close();
  });

  /** Reserves capital + persists trade `t1` (ENTRY_PENDING, allocated 1000), then saves an
   * Order recorded filled=1000 with only 900 worth of Fills underneath it — tech spec §31's
   * worked example — without going through any transition machinery (simulating silent drift). */
  function seedMismatchedOrder(): void {
    ledger.reserveCapitalAndCreateTrade(makeTrade({ legs: [makeLeg({ leg_id: 'l1', trade_id: 't1' })] }), 1000);
    repos.order.saveOrder({
      order_id: 'o1',
      client_order_id: 'c1',
      trade_id: 't1',
      leg_id: 'l1',
      purpose: 'ENTRY',
      exchange: EX,
      symbol: 'BTCUSDT',
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 1000,
      requested_notional_usdt: 100_000,
      reference_price: 100,
      order_state: 'FILLED',
      created_at: 1,
      updated_at: 1,
      terminal_time: 1,
      filled_quantity: 1000,
      remaining_quantity: 0,
      average_fill_price: 100,
      estimated_fee_usdt: 0,
      estimated_slippage_pct: 0,
    });
    repos.order.saveFill({
      fill_id: 'f1',
      order_id: 'o1',
      trade_id: 't1',
      leg_id: 'l1',
      exchange: EX,
      timestamp: 1,
      recorded_at: 1,
      created_at: 1,
      updated_at: 1,
      quantity: 900,
      price: 100,
      notional_usdt: 90_000,
      fee_usdt: 0,
      fee_asset: 'USDT',
      liquidity: 'TAKER',
      slippage_from_reference_pct: 0,
    });
  }

  function makeReconciler(): Reconciler {
    return new Reconciler({
      db,
      clock,
      repos,
      eventStore,
      ledger,
      entryHalt,
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
  }

  it('detects the §31 worked-example mismatch, writes RECONCILIATION_ERROR, fails the Trade with capital released, records reconciliation_runs, and requests an entry halt', () => {
    seedMismatchedOrder();
    const reconciler = makeReconciler();

    const result = reconciler.runOnce();

    expect(result.mismatch_count).toBe(1);
    expect(result.mismatches[0]).toMatchObject({ check_id: 'ORDER_FILL_SUM', entity_id: 'o1', trade_id: 't1' });

    const events = eventStore.replay({ trade_id: 't1' });
    expect(events.some((e) => e.event_type === 'RECONCILIATION_ERROR')).toBe(true);
    const tradeStatusEvents = events.filter((e) => e.event_type === 'TRADE_STATUS_CHANGED');
    expect(tradeStatusEvents).toHaveLength(1);
    expect((tradeStatusEvents[0].payload as { to: string }).to).toBe('FAILED');
    expect(events.some((e) => e.event_type === 'CAPITAL_RELEASED')).toBe(true);

    const trade = repos.trade.getTrade('t1');
    expect(trade?.status).toBe('FAILED');

    const latest = repos.account.getLatestAccountSnapshot('PAPER');
    expect(latest?.reserved_capital_usdt).toBe(0);
    expect(latest?.available_capital_usdt).toBe(10_000);

    expect(entryHalt.isHalted()).toBe(true);
    expect(entryHalt.reasons().some((r) => r.source === 'RECONCILIATION' && r.trade_ids.includes('t1'))).toBe(true);

    const runs = db.prepare('SELECT * FROM reconciliation_runs').all() as Array<{ run_id: string; mismatch_count: number }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe(result.run_id);
    expect(runs[0].mismatch_count).toBe(1);
  });

  it('never touches orders or positions: order fields are unchanged and no cancel/close event is ever emitted', () => {
    seedMismatchedOrder();
    const reconciler = makeReconciler();
    reconciler.runOnce();

    const order = repos.order.getOrder('o1');
    expect(order).toMatchObject({ order_state: 'FILLED', filled_quantity: 1000, remaining_quantity: 0 });

    const events = eventStore.replay();
    expect(events.some((e) => e.event_type.includes('CANCEL'))).toBe(false);
    expect(events.some((e) => e.event_type === 'POSITION_CLOSED')).toBe(false);
    expect(events.some((e) => e.event_type === 'EXIT_STARTED')).toBe(false);
  });

  it('dedups: a second pass over the same unresolved mismatch does not re-emit RECONCILIATION_ERROR nor re-attempt the (now-terminal) Trade transition', () => {
    seedMismatchedOrder();
    const reconciler = makeReconciler();
    reconciler.runOnce();
    const afterFirst = eventStore.replay({ trade_id: 't1' }).filter((e) => e.event_type === 'RECONCILIATION_ERROR').length;
    expect(afterFirst).toBe(1);

    clock.advanceTo(2000);
    const result2 = reconciler.runOnce();
    expect(result2.mismatch_count).toBe(1); // still detected...
    const afterSecond = eventStore.replay({ trade_id: 't1' }).filter((e) => e.event_type === 'RECONCILIATION_ERROR').length;
    expect(afterSecond).toBe(1); // ...but not re-emitted (dedup)

    // reconciliation_runs gets a fresh row every pass regardless of dedup.
    const runs = db.prepare('SELECT * FROM reconciliation_runs').all() as unknown[];
    expect(runs).toHaveLength(2);
  });

  it('dedup clears once a mismatch resolves, so a later recurrence is treated as new again', () => {
    seedMismatchedOrder();
    const reconciler = makeReconciler();
    reconciler.runOnce();

    // "Fix" the fill sum (simulating the underlying drift being corrected).
    repos.order.saveFill({
      fill_id: 'f2',
      order_id: 'o1',
      trade_id: 't1',
      leg_id: 'l1',
      exchange: EX,
      timestamp: 2,
      recorded_at: 2,
      created_at: 2,
      updated_at: 2,
      quantity: 100,
      price: 100,
      notional_usdt: 10_000,
      fee_usdt: 0,
      fee_asset: 'USDT',
      liquidity: 'TAKER',
      slippage_from_reference_pct: 0,
    });
    clock.advanceTo(2000);
    const resolved = reconciler.runOnce();
    expect(resolved.mismatch_count).toBe(0);

    // Re-introduce a fresh drift on a second order under a *new*, still-open trade so the
    // Trade transition doesn't collide with the already-FAILED t1.
    ledger.reserveCapitalAndCreateTrade(
      makeTrade({ trade_id: 't2', allocated_capital_usdt: 500, legs: [makeLeg({ leg_id: 'l2', trade_id: 't2' })] }),
      500,
    );
    repos.order.saveOrder({
      order_id: 'o2',
      client_order_id: 'c2',
      trade_id: 't2',
      leg_id: 'l2',
      purpose: 'ENTRY',
      exchange: EX,
      symbol: 'BTCUSDT',
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 500,
      requested_notional_usdt: 50_000,
      reference_price: 100,
      order_state: 'FILLED',
      created_at: 3,
      updated_at: 3,
      terminal_time: 3,
      filled_quantity: 500,
      remaining_quantity: 0,
      average_fill_price: 100,
      estimated_fee_usdt: 0,
      estimated_slippage_pct: 0,
    });
    repos.order.saveFill({
      fill_id: 'f3',
      order_id: 'o2',
      trade_id: 't2',
      leg_id: 'l2',
      exchange: EX,
      timestamp: 3,
      recorded_at: 3,
      created_at: 3,
      updated_at: 3,
      quantity: 400,
      price: 100,
      notional_usdt: 40_000,
      fee_usdt: 0,
      fee_asset: 'USDT',
      liquidity: 'TAKER',
      slippage_from_reference_pct: 0,
    });
    clock.advanceTo(3000);
    const third = reconciler.runOnce();
    expect(third.mismatch_count).toBe(1);
    expect(third.mismatches[0]).toMatchObject({ check_id: 'ORDER_FILL_SUM', entity_id: 'o2' });
  });

  it('start()/stop(): runs immediately, then every intervalMs via the injected Clock, and stops cleanly', () => {
    const reconciler = makeReconciler();
    const spy = vi.spyOn(reconciler, 'runOnce');

    reconciler.start();
    expect(spy).toHaveBeenCalledTimes(1);

    clock.advanceTo(1000 + DEFAULT_RECONCILIATION_CONFIG.intervalMs);
    expect(spy).toHaveBeenCalledTimes(2);

    clock.advanceTo(1000 + 2 * DEFAULT_RECONCILIATION_CONFIG.intervalMs);
    expect(spy).toHaveBeenCalledTimes(3);

    reconciler.stop();
    clock.advanceTo(1000 + 5 * DEFAULT_RECONCILIATION_CONFIG.intervalMs);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('consistent snapshot: a failure partway through handling a mismatch rolls back the whole pass, including the reconciliation_runs row', () => {
    seedMismatchedOrder();
    const failingLedger = {
      ...ledger,
      appendEvent: () => {
        throw new Error('simulated mid-pass failure');
      },
    } as unknown as Ledger;
    const reconciler = new Reconciler({
      db,
      clock,
      repos,
      eventStore,
      ledger: failingLedger,
      entryHalt,
      config: DEFAULT_RECONCILIATION_CONFIG,
    });

    expect(() => reconciler.runOnce()).toThrow('simulated mid-pass failure');

    const runs = db.prepare('SELECT * FROM reconciliation_runs').all() as unknown[];
    expect(runs).toHaveLength(0);
    const trade = repos.trade.getTrade('t1');
    expect(trade?.status).toBe('ENTRY_PENDING'); // not transitioned to FAILED — rolled back
    expect(entryHalt.isHalted()).toBe(false); // ENTRY_HALT_REQUESTED never committed either
  });
});
