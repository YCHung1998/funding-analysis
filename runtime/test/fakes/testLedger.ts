/**
 * runtime/test/fakes/testLedger.ts
 *
 * Shared test harness: a fresh in-memory-backed `Ledger` + `VirtualClock` +
 * repositories, with one `trades` row and two `trade_legs` rows pre-seeded
 * (long/short), mirroring the fixture shape used by
 * `runtime/src/storage/ledger.test.ts` / `positionFundingPnl.scenario.test.ts`.
 * Execution tests build `OrderRequest`s against `legL`/`legS` of `trade1`.
 */
import type { AccountSnapshot, Trade, TradeLeg } from '../../src/types';
import { VirtualClock } from '../../src/clock/virtualClock';
import { createAccountRepository } from '../../src/storage/accountRepository';
import type { SqliteDriver } from '../../src/storage/driver';
import { NodeSqliteDriver } from '../../src/storage/driver';
import { EventStore, type StoredTradingEvent } from '../../src/storage/eventStore';
import { Ledger } from '../../src/storage/ledger';
import { migrate } from '../../src/storage/migrate';
import { migration001 } from '../../src/storage/migrations/001_initial';
import { migration002 } from '../../src/storage/migrations/002_position_accounting_fields';
import { createOrderRepository } from '../../src/storage/orderRepository';
import { createTradeRepository } from '../../src/storage/tradeRepository';
import { tmpDriver } from '../../src/storage/test-helpers';

const RISK_PASS = {
  overall_status: 'PASS' as const,
  checks: [],
  failed_reasons: [],
  leg_imbalance_detected: false,
  action_recommendation: 'PROCEED_TRADE' as const,
};

export interface TestLedgerHarness {
  db: SqliteDriver & NodeSqliteDriver;
  clock: VirtualClock;
  ledger: Ledger;
  eventStore: EventStore;
  tradeRepo: ReturnType<typeof createTradeRepository>;
  orderRepo: ReturnType<typeof createOrderRepository>;
  accountRepo: ReturnType<typeof createAccountRepository>;
  uiEvents: StoredTradingEvent[];
  close(): void;
}

export function makeTestLedger(opts: { start?: number; tradeId?: string } = {}): TestLedgerHarness {
  const db = tmpDriver();
  migrate(db, [migration001, migration002]);
  const clock = new VirtualClock(opts.start ?? 0);
  const tradeRepo = createTradeRepository(db);
  const orderRepo = createOrderRepository(db);
  const accountRepo = createAccountRepository(db);
  const eventStore = new EventStore(db, clock);
  const uiEvents: StoredTradingEvent[] = [];
  const ledger = new Ledger(db, clock, { trade: tradeRepo, order: orderRepo, account: accountRepo }, eventStore, (e) =>
    uiEvents.push(e),
  );

  const initial: AccountSnapshot = {
    snapshot_id: 'init',
    mode: 'PAPER',
    snapshot_time: 0,
    total_capital_usdt: 100_000,
    reserved_capital_usdt: 0,
    available_capital_usdt: 100_000,
    used_margin_usdt: 0,
    realized_pnl_usdt: 0,
    open_trade_count: 0,
    reason: 'INITIAL',
    config_version: 'c1',
    created_at: 0,
    updated_at: 0,
  };
  accountRepo.saveAccountSnapshot(initial);

  const tradeId = opts.tradeId ?? 'trade1';
  tradeRepo.saveOpportunity({
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

  const trade: Trade = {
    trade_id: tradeId,
    opportunity_id: 'opp1',
    strategy_id: 's1',
    strategy_version: 'v1',
    config_version: 'c1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    created_at: opts.start ?? 0,
    updated_at: opts.start ?? 0,
    status: 'CREATED',
    target_notional_per_leg_usdt: 1000,
    leverage: 1,
    allocated_margin_usdt: 1000,
    allocated_capital_usdt: 2000,
    legs: [],
    expected_pnl_usdt: 1,
    risk_status: RISK_PASS,
  };
  ledger.reserveCapitalAndCreateTrade(trade, 2000);

  const legL: TradeLeg = {
    leg_id: 'legL',
    trade_id: tradeId,
    exchange: 'Binance',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    order_side: 'BUY',
    leverage: 1,
    target_notional_usdt: 1000,
    target_quantity: 10,
    margin_allocated_usdt: 500,
    target_entry_price: 100,
    entry_order_ids: [],
    exit_order_ids: [],
    status: 'PENDING',
    created_at: opts.start ?? 0,
    updated_at: opts.start ?? 0,
  };
  const legS: TradeLeg = {
    leg_id: 'legS',
    trade_id: tradeId,
    exchange: 'Bybit',
    symbol: 'BTCUSDT',
    direction: 'SHORT',
    order_side: 'SELL',
    leverage: 1,
    target_notional_usdt: 1000,
    target_quantity: 10,
    margin_allocated_usdt: 500,
    target_entry_price: 100,
    entry_order_ids: [],
    exit_order_ids: [],
    status: 'PENDING',
    created_at: opts.start ?? 0,
    updated_at: opts.start ?? 0,
  };
  tradeRepo.saveTradeLeg(legL);
  tradeRepo.saveTradeLeg(legS);

  return {
    db,
    clock,
    ledger,
    eventStore,
    tradeRepo,
    orderRepo,
    accountRepo,
    uiEvents,
    close: () => db.close(),
  };
}
