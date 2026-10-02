/**
 * runtime/test/helpers/assertTraceability.test.ts
 *
 * Task 4.3 — `assertTraceability(db, { trade_id? })`: missing timestamp,
 * state not matching last event, missing event, events out of chronological
 * order (tech spec §42, spec "Traceability assertion helper") — positive and
 * negative cases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/clock/virtualClock';
import { NodeSqliteDriver } from '../../src/storage/driver';
import { EventStore } from '../../src/storage/eventStore';
import { Ledger } from '../../src/storage/ledger';
import { migrate } from '../../src/storage/migrate';
import { migration001 } from '../../src/storage/migrations/001_initial';
import { migration002 } from '../../src/storage/migrations/002_position_accounting_fields';
import { createOrderRepository } from '../../src/storage/orderRepository';
import { createAccountRepository } from '../../src/storage/accountRepository';
import { createTradeRepository } from '../../src/storage/tradeRepository';
import { tmpDriver } from '../../src/storage/test-helpers';
import type { AccountSnapshot, PaperOrder, Trade } from '../../src/types';
import { assertTraceability, TraceabilityError } from './assertTraceability';

const RISK_PASS = {
  overall_status: 'PASS' as const,
  checks: [],
  failed_reasons: [],
  leg_imbalance_detected: false,
  action_recommendation: 'PROCEED_TRADE' as const,
};

describe('assertTraceability', () => {
  let db: NodeSqliteDriver;
  let clock: VirtualClock;
  let tradeRepo: ReturnType<typeof createTradeRepository>;
  let orderRepo: ReturnType<typeof createOrderRepository>;
  let accountRepo: ReturnType<typeof createAccountRepository>;
  let eventStore: EventStore;
  let ledger: Ledger;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001, migration002]);
    clock = new VirtualClock(1000);
    tradeRepo = createTradeRepository(db);
    orderRepo = createOrderRepository(db);
    accountRepo = createAccountRepository(db);
    eventStore = new EventStore(db, clock);
    ledger = new Ledger(db, clock, { trade: tradeRepo, order: orderRepo, account: accountRepo }, eventStore);

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
  });

  afterEach(() => {
    db.close();
  });

  function makeTrade(): Trade {
    return {
      trade_id: 'trade1',
      opportunity_id: 'opp1',
      strategy_id: 's1',
      strategy_version: 'v1',
      config_version: 'c1',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      created_at: 1000,
      updated_at: 1000,
      status: 'CREATED',
      target_notional_per_leg_usdt: 1000,
      leverage: 1,
      allocated_margin_usdt: 100,
      allocated_capital_usdt: 1000,
      legs: [],
      expected_pnl_usdt: 0,
      risk_status: RISK_PASS,
    };
  }

  it('passes for a trade recorded only through Ledger and EventStore', () => {
    ledger.reserveCapitalAndCreateTrade(makeTrade(), 1000);
    expect(() => assertTraceability(db, { trade_id: 'trade1' })).not.toThrow();
  });

  it('fails naming the order id and missing transition when an order is updated to CANCELED without an ORDER_CANCELED event', () => {
    ledger.reserveCapitalAndCreateTrade(makeTrade(), 1000);
    db.prepare(
      `INSERT INTO trade_legs (leg_id, trade_id, exchange, symbol, direction, order_side, leverage, target_notional_usdt, target_quantity, margin_allocated_usdt, target_entry_price, entry_order_ids, exit_order_ids, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('leg1', 'trade1', 'Binance', 'BTCUSDT', 'LONG', 'BUY', 1, 1000, 0.1, 100, 10000, '[]', '[]', 'PENDING', 1000, 1000);
    const order: PaperOrder = {
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
      order_state: 'CANCELED', // written directly — no ORDER_CANCELED event appended
      created_at: 1000,
      updated_at: 1000,
      filled_quantity: 0,
      remaining_quantity: 0.1,
      estimated_fee_usdt: 1,
      estimated_slippage_pct: 0.0001,
      terminal_time: 1000,
    };
    orderRepo.saveOrder(order);

    expect(() => assertTraceability(db, { trade_id: 'trade1' })).toThrow(TraceabilityError);
    try {
      assertTraceability(db, { trade_id: 'trade1' });
    } catch (err) {
      expect(err).toBeInstanceOf(TraceabilityError);
      const message = (err as TraceabilityError).message;
      expect(message).toContain('order1');
    }
  });

  it('fails when an entity row lacks created_at/updated_at', () => {
    // `001_initial`'s trades.updated_at is NOT NULL (proven by task 2.1's
    // tests), so this rule can only be exercised against a schema that
    // doesn't enforce it — e.g. a row written by a future/buggy writer that
    // bypasses the normal repository path. Build a minimal standalone db
    // with the same column names but no NOT NULL, to isolate this one rule.
    const bare = tmpDriver();
    bare.exec(`CREATE TABLE trades (trade_id TEXT PRIMARY KEY, status TEXT, created_at INTEGER, updated_at INTEGER)`);
    bare.exec(`CREATE TABLE orders (order_id TEXT PRIMARY KEY, trade_id TEXT, order_state TEXT, created_at INTEGER, updated_at INTEGER)`);
    bare.exec(`CREATE TABLE trade_legs (leg_id TEXT PRIMARY KEY, trade_id TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)`);
    bare.exec(
      `CREATE TABLE funding_settlements (funding_id TEXT PRIMARY KEY, trade_id TEXT, settlement_status TEXT, created_at INTEGER, updated_at INTEGER)`,
    );
    bare.exec(
      `CREATE TABLE trading_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, event_type TEXT, timestamp INTEGER, trade_id TEXT, order_id TEXT, leg_id TEXT, payload TEXT)`,
    );
    bare.prepare(`INSERT INTO trades (trade_id, status, created_at, updated_at) VALUES (?,?,?,NULL)`).run('t1', 'CREATED', 1000);
    bare
      .prepare(`INSERT INTO trading_events (event_id, event_type, timestamp, trade_id, payload) VALUES (?,?,?,?,?)`)
      .run('e1', 'TRADE_CREATED', 1000, 't1', JSON.stringify({ after: { status: 'CREATED' } }));

    expect(() => assertTraceability(bare, { trade_id: 't1' })).toThrow(TraceabilityError);
    bare.close();
  });

  it('fails when an entity status differs from the `to` of its last transition event', () => {
    ledger.reserveCapitalAndCreateTrade(makeTrade(), 1000);
    // Directly mutate status without an event — simulates a status drift bug.
    db.exec(`UPDATE trades SET status = 'FAILED' WHERE trade_id = 'trade1'`);
    expect(() => assertTraceability(db, { trade_id: 'trade1' })).toThrow(TraceabilityError);
  });

  it('fails when event timestamps for one trade decrease with increasing seq', () => {
    ledger.reserveCapitalAndCreateTrade(makeTrade(), 1000);
    // Append an out-of-order event directly via the store (seq keeps increasing, timestamp goes backwards).
    eventStore.append({
      event_id: 'late-but-earlier-ts',
      event_type: 'RISK_CHECK_PASSED',
      timestamp: 1, // earlier than the CAPITAL_RESERVED/TRADE_CREATED events (timestamp 1000)
      trade_id: 'trade1',
      payload: {},
    });
    expect(() => assertTraceability(db, { trade_id: 'trade1' })).toThrow(TraceabilityError);
  });
});
