/**
 * runtime/src/reconciliation/capitalAtomicity.test.ts
 *
 * Task 2.2 — capital reservation atomicity (tech spec §12) from the
 * reconciliation module's point of view: repeated over-reservation is
 * always rejected and never leaves a partial trace, a mid-reservation
 * failure rolls back everything (row + event), and `checkCapitalEventPairing`
 * correctly flags a Trade that is missing its `CAPITAL_RESERVED` /
 * `CAPITAL_RELEASED` event pairing. Uses a real `Ledger` + `EventStore` +
 * temp-dir SQLite DB (never a real file in `data/`) and a `VirtualClock`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountSnapshot, Trade } from '../types';
import { VirtualClock } from '../clock/virtualClock';
import { createAccountRepository } from '../storage/accountRepository';
import { NodeSqliteDriver } from '../storage/driver';
import { EventStore } from '../storage/eventStore';
import { InsufficientCapitalError, Ledger, type LedgerRepos } from '../storage/ledger';
import { migrate } from '../storage/migrate';
import { migration001 } from '../storage/migrations/001_initial';
import { migration002 } from '../storage/migrations/002_position_accounting_fields';
import { createOrderRepository } from '../storage/orderRepository';
import { createTradeRepository } from '../storage/tradeRepository';
import { tmpDriver } from '../storage/test-helpers';
import { checkCapitalAvailable, checkCapitalEventPairing, checkCapitalReservedSum } from './checks';
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

const CFG = DEFAULT_RECONCILIATION_CONFIG;

describe('capital reservation atomicity (reconciliation perspective)', () => {
  let db: NodeSqliteDriver;
  let clock: VirtualClock;
  let repos: LedgerRepos;
  let eventStore: EventStore;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001, migration002]);
    clock = new VirtualClock(1000);
    repos = {
      trade: createTradeRepository(db),
      order: createOrderRepository(db),
      account: createAccountRepository(db),
    };
    eventStore = new EventStore(db, clock);

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

  it('rejects repeated over-reservation attempts and never accumulates a partial reservation', () => {
    const ledger = new Ledger(db, clock, repos, eventStore);
    for (let i = 0; i < 5; i++) {
      expect(() => ledger.reserveCapitalAndCreateTrade(makeTrade({ trade_id: `t${i}`, allocated_capital_usdt: 20_000 }), 20_000)).toThrow(
        InsufficientCapitalError,
      );
    }
    const latest = repos.account.getLatestAccountSnapshot('PAPER');
    expect(latest?.reserved_capital_usdt).toBe(0);
    expect(latest?.available_capital_usdt).toBe(10_000);
    expect(eventStore.replay()).toEqual([]);
  });

  it('rolls back the account snapshot and any event when the trade write fails mid-transaction', () => {
    const failingRepos: LedgerRepos = {
      ...repos,
      trade: {
        ...repos.trade,
        saveTrade: () => {
          throw new Error('simulated mid-transaction failure');
        },
      },
    };
    const ledger = new Ledger(db, clock, failingRepos, eventStore);
    expect(() => ledger.reserveCapitalAndCreateTrade(makeTrade(), 1000)).toThrow('simulated mid-transaction failure');

    const latest = repos.account.getLatestAccountSnapshot('PAPER');
    expect(latest?.snapshot_id).toBe('init');
    expect(latest?.reserved_capital_usdt).toBe(0);
    expect(eventStore.replay()).toEqual([]);
    expect(repos.trade.getTrade('trade1')).toBeUndefined();
  });

  it('checkCapitalReservedSum flags when account.reserved disagrees with sum of non-terminal trade allocations', () => {
    const trades = [makeTrade({ trade_id: 't1', status: 'HEDGED', allocated_capital_usdt: 1000 })];
    const snapshot: AccountSnapshot = {
      snapshot_id: 's1',
      mode: 'PAPER',
      snapshot_time: 1,
      total_capital_usdt: 10_000,
      reserved_capital_usdt: 5000,
      available_capital_usdt: 5000,
      used_margin_usdt: 0,
      realized_pnl_usdt: 0,
      open_trade_count: 1,
      reason: 'CAPITAL_RESERVED',
      config_version: 'c1',
      created_at: 1,
      updated_at: 1,
    };
    expect(checkCapitalReservedSum(trades, snapshot, CFG)).toHaveLength(1);
  });

  it('checkCapitalAvailable flags when available != total - reserved', () => {
    const snapshot: AccountSnapshot = {
      snapshot_id: 's1',
      mode: 'PAPER',
      snapshot_time: 1,
      total_capital_usdt: 10_000,
      reserved_capital_usdt: 1000,
      available_capital_usdt: 8000,
      used_margin_usdt: 0,
      realized_pnl_usdt: 0,
      open_trade_count: 1,
      reason: 'CAPITAL_RESERVED',
      config_version: 'c1',
      created_at: 1,
      updated_at: 1,
    };
    expect(checkCapitalAvailable(snapshot, CFG)).toHaveLength(1);
  });

  it('checkCapitalEventPairing: real reserve+release flow produces a clean pairing (no mismatch)', () => {
    const ledger = new Ledger(db, clock, repos, eventStore);
    ledger.reserveCapitalAndCreateTrade(makeTrade({ trade_id: 't1', status: 'CREATED' }), 1000);
    const closed = makeTrade({ trade_id: 't1', status: 'FAILED' });
    ledger.applyTradeTransition(makeTrade({ trade_id: 't1', status: 'CREATED' }), closed, 'RECONCILIATION_ERROR', {
      releaseCapitalReason: 'RECONCILIATION_ERROR',
    });

    const events = eventStore.replay({ trade_id: 't1' });
    const reserved = events.filter((e) => e.event_type === 'CAPITAL_RESERVED').length;
    const released = events.filter((e) => e.event_type === 'CAPITAL_RELEASED').length;
    expect(checkCapitalEventPairing(closed, { reserved, released })).toEqual([]);
  });

  it('checkCapitalEventPairing: flags a terminal trade missing its CAPITAL_RELEASED event', () => {
    const ledger = new Ledger(db, clock, repos, eventStore);
    ledger.reserveCapitalAndCreateTrade(makeTrade({ trade_id: 't1', status: 'CREATED' }), 1000);
    // Trade is force-marked FAILED by a reconciliation Trade transition elsewhere, but
    // capital was never released (e.g. the release step itself failed) — simulate by
    // reading events without ever calling applyTradeTransition's releaseCapitalReason.
    const failed = makeTrade({ trade_id: 't1', status: 'FAILED' });
    const events = eventStore.replay({ trade_id: 't1' });
    const reserved = events.filter((e) => e.event_type === 'CAPITAL_RESERVED').length;
    const released = events.filter((e) => e.event_type === 'CAPITAL_RELEASED').length;
    const mismatches = checkCapitalEventPairing(failed, { reserved, released });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].check_id).toBe('CAPITAL_EVENT_PAIRING');
  });
});
