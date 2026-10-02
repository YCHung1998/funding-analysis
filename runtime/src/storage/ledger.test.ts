/**
 * runtime/src/storage/ledger.test.ts
 *
 * Task 4.2 — `Ledger` synchronous transactions: reserveCapitalAndCreateTrade,
 * releaseCapital, applyOrderTransition, applyFill; INSUFFICIENT_CAPITAL;
 * full rollback on mid-transaction failure; ledger events are UI-only
 * (never replayed into writes) (spec "Synchronous ledger commits").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountSnapshot, Fill, PaperOrder, PaperPosition, Trade } from '../types';
import { VirtualClock } from '../clock/virtualClock';
import { createAccountRepository } from './accountRepository';
import { NodeSqliteDriver } from './driver';
import { EventStore } from './eventStore';
import { InsufficientCapitalError, Ledger } from './ledger';
import { migrate } from './migrate';
import { migration001 } from './migrations/001_initial';
import { migration002 } from './migrations/002_position_accounting_fields';
import { createOrderRepository } from './orderRepository';
import { createTradeRepository } from './tradeRepository';
import { tmpDriver } from './test-helpers';

const RISK_PASS = {
  overall_status: 'PASS' as const,
  checks: [],
  failed_reasons: [],
  leg_imbalance_detected: false,
  action_recommendation: 'PROCEED_TRADE' as const,
};

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    trade_id: 'trade1',
    opportunity_id: 'opp1',
    strategy_id: 's1',
    strategy_version: 'v1',
    config_version: 'c1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    created_at: 1,
    updated_at: 1,
    status: 'CREATED',
    target_notional_per_leg_usdt: 1000,
    leverage: 1,
    allocated_margin_usdt: 100,
    allocated_capital_usdt: 1000,
    legs: [],
    expected_pnl_usdt: 0,
    risk_status: RISK_PASS,
    ...overrides,
  };
}

describe('Ledger', () => {
  let db: NodeSqliteDriver;
  let clock: VirtualClock;
  let ledger: Ledger;
  let tradeRepo: ReturnType<typeof createTradeRepository>;
  let orderRepo: ReturnType<typeof createOrderRepository>;
  let accountRepo: ReturnType<typeof createAccountRepository>;
  let eventStore: EventStore;
  let uiEvents: string[];

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001, migration002]);
    clock = new VirtualClock(1000);
    tradeRepo = createTradeRepository(db);
    orderRepo = createOrderRepository(db);
    accountRepo = createAccountRepository(db);
    eventStore = new EventStore(db, clock);
    uiEvents = [];

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
    accountRepo.saveAccountSnapshot(initial);

    tradeRepo.saveOpportunity({
      opportunity_id: 'opp1',
      symbol: 'BTCUSDT',
      created_at: 1,
      detected_at: 1,
      expires_at: 2,
      updated_at: 1,
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

    ledger = new Ledger(db, clock, { trade: tradeRepo, order: orderRepo, account: accountRepo }, eventStore, (event) =>
      uiEvents.push(event.event_type),
    );
  });

  afterEach(() => {
    db.close();
  });

  it('reserveCapitalAndCreateTrade: reserved before any fill shows reserved/available correctly', () => {
    const trade = makeTrade();
    const result = ledger.reserveCapitalAndCreateTrade(trade, 1000);
    expect(result.snapshot.reserved_capital_usdt).toBe(1000);
    expect(result.snapshot.available_capital_usdt).toBe(9000);
    expect(accountRepo.getLatestAccountSnapshot('PAPER')?.available_capital_usdt).toBe(9000);
    expect(tradeRepo.getTrade('trade1')).toEqual(trade);
  });

  it('a 6000 reservation against 5000 available fails with INSUFFICIENT_CAPITAL and writes nothing', () => {
    // First consume capital down to 5000 available.
    ledger.reserveCapitalAndCreateTrade(makeTrade({ trade_id: 'trade0', allocated_capital_usdt: 5000 }), 5000);
    const before = tradeRepo.getTrade('trade1');
    expect(before).toBeUndefined();
    expect(() => ledger.reserveCapitalAndCreateTrade(makeTrade({ allocated_capital_usdt: 6000 }), 6000)).toThrow(
      InsufficientCapitalError,
    );
    expect(tradeRepo.getTrade('trade1')).toBeUndefined();
    const snapshot = accountRepo.getLatestAccountSnapshot('PAPER')!;
    expect(snapshot.reserved_capital_usdt).toBe(5000);
    expect(snapshot.available_capital_usdt).toBe(5000);
  });

  it('releaseCapital returns the reserved amount and appends CAPITAL_RELEASED', () => {
    const trade = makeTrade({ allocated_capital_usdt: 1000 });
    ledger.reserveCapitalAndCreateTrade(trade, 1000);
    const result = ledger.releaseCapital('trade1', 'TRADE_ABORTED');
    expect(result.snapshot.reason).toBe('CAPITAL_RELEASED');
    expect(result.snapshot.reserved_capital_usdt).toBe(0);
    expect(result.snapshot.available_capital_usdt).toBe(10_000);
    const events = eventStore.replay({ trade_id: 'trade1' }).map((e) => e.event_type);
    expect(events).toContain('CAPITAL_RELEASED');
  });

  it('applyOrderTransition commits order row + event in one transaction', () => {
    const trade = makeTrade();
    ledger.reserveCapitalAndCreateTrade(trade, 1000);
    db.prepare(
      `INSERT INTO trade_legs (leg_id, trade_id, exchange, symbol, direction, order_side, leverage, target_notional_usdt, target_quantity, margin_allocated_usdt, target_entry_price, entry_order_ids, exit_order_ids, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('leg1', 'trade1', 'Binance', 'BTCUSDT', 'LONG', 'BUY', 1, 1000, 0.1, 100, 10000, '[]', '[]', 'PENDING', 1, 1);
    const before: PaperOrder = {
      order_id: 'order1',
      client_order_id: 'c1',
      trade_id: 'trade1',
      leg_id: 'leg1',
      purpose: 'ENTRY',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 0.1,
      requested_notional_usdt: 1000,
      reference_price: 10000,
      order_state: 'CREATED',
      created_at: 1,
      updated_at: 1,
      filled_quantity: 0,
      remaining_quantity: 0.1,
      estimated_fee_usdt: 1,
      estimated_slippage_pct: 0.0001,
    };
    orderRepo.saveOrder(before);
    const after: PaperOrder = { ...before, order_state: 'SUBMITTED', submit_time: 1000, updated_at: 1000 };
    const result = ledger.applyOrderTransition(before, after, 'submitted to exchange');
    expect(orderRepo.getOrder('order1')?.order_state).toBe('SUBMITTED');
    expect(result.event.event_type).toBe('ORDER_SUBMITTED');
  });

  it('applyFill commits fill + order + position rows and ORDER_FILL event atomically', () => {
    const trade = makeTrade();
    ledger.reserveCapitalAndCreateTrade(trade, 1000);
    const legId = 'leg1';
    db.prepare(
      `INSERT INTO trade_legs (leg_id, trade_id, exchange, symbol, direction, order_side, leverage, target_notional_usdt, target_quantity, margin_allocated_usdt, target_entry_price, entry_order_ids, exit_order_ids, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(legId, 'trade1', 'Binance', 'BTCUSDT', 'LONG', 'BUY', 1, 1000, 0.1, 100, 10000, '[]', '[]', 'PENDING', 1, 1);
    const orderBefore: PaperOrder = {
      order_id: 'order1',
      client_order_id: 'c1',
      trade_id: 'trade1',
      leg_id: legId,
      purpose: 'ENTRY',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 0.1,
      requested_notional_usdt: 1000,
      reference_price: 10000,
      order_state: 'ACKNOWLEDGED',
      created_at: 1,
      updated_at: 1,
      filled_quantity: 0,
      remaining_quantity: 0.1,
      estimated_fee_usdt: 1,
      estimated_slippage_pct: 0.0001,
    };
    orderRepo.saveOrder(orderBefore);
    const orderAfter: PaperOrder = { ...orderBefore, order_state: 'FILLED', filled_quantity: 0.1, remaining_quantity: 0, updated_at: 1000, terminal_time: 1000 };
    const fill: Fill = {
      fill_id: 'fill1',
      order_id: 'order1',
      trade_id: 'trade1',
      leg_id: legId,
      exchange: 'Binance',
      timestamp: 1000,
      recorded_at: 1000,
      created_at: 1000,
      updated_at: 1000,
      quantity: 0.1,
      price: 10000,
      notional_usdt: 1000,
      fee_usdt: 1,
      fee_asset: 'USDT',
      liquidity: 'TAKER',
      slippage_from_reference_pct: 0,
    };
    const position: PaperPosition = {
      position_id: 'pos1',
      trade_id: 'trade1',
      leg_id: legId,
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      position_side: 'LONG',
      quantity: 0.1,
      average_entry_price: 10000,
      status: 'OPEN',
      opened_at: 1000,
      created_at: 1000,
      updated_at: 1000,
      base_quantity: 0.1,
      entry_filled_quantity: 0.1,
      exit_filled_quantity: 0,
      entry_notional_usdt: 1000,
      realized_price_pnl_usdt: 0,
      fees_usdt: 1,
      slippage_attribution_usdt: 0,
      applied_fill_ids: ['fill1'],
    };

    const result = ledger.applyFill({ fill, orderBefore, orderAfter, reason: 'filled', position, positionEventType: 'POSITION_OPENED' });

    expect(orderRepo.getOrder('order1')?.order_state).toBe('FILLED');
    expect(orderRepo.listFillsForOrder('order1')).toEqual([fill]);
    expect(orderRepo.getPosition('pos1')).toEqual(position);
    expect(result.events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['ORDER_FILL', 'POSITION_OPENED']));
  });

  it('applyFill rolls back everything when the position write fails (atomicity)', () => {
    const trade = makeTrade();
    ledger.reserveCapitalAndCreateTrade(trade, 1000);
    const orderBefore: PaperOrder = {
      order_id: 'order2',
      client_order_id: 'c2',
      trade_id: 'trade1',
      leg_id: 'does-not-exist-leg',
      purpose: 'ENTRY',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 0.1,
      requested_notional_usdt: 1000,
      reference_price: 10000,
      order_state: 'ACKNOWLEDGED',
      created_at: 1,
      updated_at: 1,
      filled_quantity: 0,
      remaining_quantity: 0.1,
      estimated_fee_usdt: 1,
      estimated_slippage_pct: 0.0001,
    };
    // Note: no trade_legs row for 'does-not-exist-leg' exists, so
    // orderRepo.saveOrder itself (FK orders.leg_id -> trade_legs) will fail
    // inside the ledger transaction, exercising full rollback.
    const orderAfter: PaperOrder = { ...orderBefore, order_state: 'FILLED', filled_quantity: 0.1, remaining_quantity: 0 };
    const fill: Fill = {
      fill_id: 'fill-bad',
      order_id: 'order2',
      trade_id: 'trade1',
      leg_id: 'does-not-exist-leg',
      exchange: 'Binance',
      timestamp: 1000,
      recorded_at: 1000,
      created_at: 1000,
      updated_at: 1000,
      quantity: 0.1,
      price: 10000,
      notional_usdt: 1000,
      fee_usdt: 1,
      fee_asset: 'USDT',
      liquidity: 'TAKER',
      slippage_from_reference_pct: 0,
    };
    const position: PaperPosition = {
      position_id: 'pos-bad',
      trade_id: 'trade1',
      leg_id: 'does-not-exist-leg',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      position_side: 'LONG',
      quantity: 0.1,
      average_entry_price: 10000,
      status: 'OPEN',
      opened_at: 1000,
      created_at: 1000,
      updated_at: 1000,
      base_quantity: 0.1,
      entry_filled_quantity: 0.1,
      exit_filled_quantity: 0,
      entry_notional_usdt: 1000,
      realized_price_pnl_usdt: 0,
      fees_usdt: 1,
      slippage_attribution_usdt: 0,
      applied_fill_ids: ['fill-bad'],
    };

    expect(() =>
      ledger.applyFill({ fill, orderBefore, orderAfter, reason: 'filled', position, positionEventType: 'POSITION_OPENED' }),
    ).toThrow();

    expect(orderRepo.getOrder('order2')).toBeUndefined();
    expect(orderRepo.listFillsForOrder('order2')).toEqual([]);
    expect(orderRepo.getPosition('pos-bad')).toBeUndefined();
    expect(eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === 'order2')).toEqual([]);
  });

  it('ledger events are passed only to the UI callback, never through EventQueue/DatabaseWriter re-write', () => {
    const trade = makeTrade();
    ledger.reserveCapitalAndCreateTrade(trade, 1000);
    expect(uiEvents).toEqual(expect.arrayContaining(['CAPITAL_RESERVED', 'TRADE_CREATED']));
    // Events were written exactly once each by EventStore.append inside the
    // ledger transaction (not duplicated via any queue/writer path).
    const rows = db.prepare('SELECT event_type, COUNT(*) as n FROM trading_events GROUP BY event_type').all() as {
      event_type: string;
      n: number;
    }[];
    for (const row of rows) expect(row.n).toBe(1);
  });
});
