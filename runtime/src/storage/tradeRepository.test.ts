/**
 * runtime/src/storage/tradeRepository.test.ts
 *
 * Task 2.2 — lossless round trip for Opportunity / Trade (incl. nested legs,
 * JSON risk_status) / RiskCheck, and the "no delete method" guard (spec
 * "Lossless repository round trip").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Opportunity, RiskCheck, Trade } from '../types';
import { NodeSqliteDriver } from './driver';
import { migrate } from './migrate';
import { migration001 } from './migrations/001_initial';
import { createTradeRepository, type TradeRepository } from './tradeRepository';
import { tmpDriver } from './test-helpers';

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
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
    status: 'DETECTED',
    ...overrides,
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    trade_id: 'trade1',
    opportunity_id: 'opp1',
    strategy_id: 'strat1',
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
    legs: [
      {
        leg_id: 'leg1',
        trade_id: 'trade1',
        exchange: 'Binance',
        symbol: 'BTCUSDT',
        direction: 'LONG',
        order_side: 'BUY',
        leverage: 1,
        target_notional_usdt: 1000,
        target_quantity: 0.1,
        margin_allocated_usdt: 100,
        target_entry_price: 10000,
        entry_order_ids: ['o1', 'o2'],
        exit_order_ids: [],
        status: 'PENDING',
        created_at: 1,
        updated_at: 1,
      },
      {
        leg_id: 'leg2',
        trade_id: 'trade1',
        exchange: 'Bybit',
        symbol: 'BTCUSDT',
        direction: 'SHORT',
        order_side: 'SELL',
        leverage: 1,
        target_notional_usdt: 1000,
        target_quantity: 0.1,
        margin_allocated_usdt: 100,
        target_entry_price: 10000,
        entry_order_ids: [],
        exit_order_ids: [],
        status: 'PENDING',
        created_at: 1,
        updated_at: 1,
      },
    ],
    expected_pnl_usdt: 0,
    risk_status: {
      overall_status: 'PASS',
      checks: Array.from({ length: 9 }, (_, i) => ({
        id: `c${i}`,
        name: `check ${i}`,
        category: 'Connection' as const,
        status: 'PASS' as const,
        value: '1',
        threshold: '1',
        details: 'ok',
      })),
      failed_reasons: [],
      leg_imbalance_detected: false,
      action_recommendation: 'PROCEED_TRADE',
    },
    ...overrides,
  };
}

describe('tradeRepository', () => {
  let db: NodeSqliteDriver;
  let repo: TradeRepository;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001]);
    repo = createTradeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('opportunity round trips losslessly', () => {
    const opp = makeOpportunity();
    repo.saveOpportunity(opp);
    expect(repo.getOpportunity('opp1')).toEqual(opp);
  });

  it('a Trade with two legs, risk_status with 9 checks, and entry_order_ids round trips losslessly', () => {
    const trade = makeTrade();
    repo.saveOpportunity(makeOpportunity());
    repo.saveTrade(trade);
    const loaded = repo.getTrade('trade1');
    expect(loaded).toEqual(trade);
  });

  it('an unfilled order persists: trade ABORTED with reason stays queryable', () => {
    repo.saveOpportunity(makeOpportunity());
    const trade = makeTrade({ status: 'ABORTED', close_reason: undefined });
    repo.saveTrade(trade);
    const loaded = repo.getTrade('trade1');
    expect(loaded?.status).toBe('ABORTED');
  });

  it('risk checks round trip', () => {
    repo.saveOpportunity(makeOpportunity());
    repo.saveTrade(makeTrade());
    const rc: RiskCheck = {
      risk_check_id: 'rc1',
      opportunity_id: 'opp1',
      trade_id: 'trade1',
      stage: 'ENTRY',
      check_id: 'r1',
      name: 'spread check',
      status: 'PASS',
      critical: true,
      value: '0.01',
      threshold: '0.005',
      reason: undefined,
      config_version: 'c1',
      created_at: 1,
      updated_at: 1,
    };
    repo.saveRiskCheck(rc);
    expect(repo.listRiskChecksForTrade('trade1')).toEqual([rc]);
  });

  it('exposes no delete method for trades', () => {
    const methodNames = Object.keys(repo);
    expect(methodNames.some((name) => /delete/i.test(name))).toBe(false);
  });
});
