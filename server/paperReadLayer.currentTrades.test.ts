/**
 * server/paperReadLayer.currentTrades.test.ts — task 2.1.
 *
 * Covers `getCurrentTrades()`: alert-status-first ordering
 * (`LEG_IMBALANCE`/`EMERGENCY_EXIT`/`FAILED`), `created_at` descending
 * within each group, terminal trades excluded, empty state, and the derived
 * `CurrentTradeSummary` fields (design.md Implementation Notes).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPaperDbFixture, type PaperDbFixture } from './test/paperDbFixture';
import { getCurrentTrades, openPaperDb } from './paperReadLayer';
import type { Opportunity, Trade, TradeLeg, TradeStatus } from '../runtime/src/types';

const RISK_PASS = {
  overall_status: 'PASS' as const,
  checks: [],
  failed_reasons: [],
  leg_imbalance_detected: false,
  action_recommendation: 'PROCEED_TRADE' as const,
};

function opportunity(id: string): Opportunity {
  return {
    opportunity_id: id,
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
  };
}

function trade(id: string, status: TradeStatus, createdAt: number): Trade {
  return {
    trade_id: id,
    opportunity_id: `opp-${id}`,
    strategy_id: 's1',
    strategy_version: 'v1',
    config_version: 'c1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    created_at: createdAt,
    updated_at: createdAt,
    status,
    target_notional_per_leg_usdt: 1000,
    leverage: 1,
    allocated_margin_usdt: 500,
    allocated_capital_usdt: 1000,
    legs: [],
    expected_pnl_usdt: 1,
    risk_status: RISK_PASS,
  };
}

function legs(tradeId: string): [TradeLeg, TradeLeg] {
  return [
    {
      leg_id: `${tradeId}-L`,
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
      status: 'OPEN',
      created_at: 0,
      updated_at: 0,
    },
    {
      leg_id: `${tradeId}-S`,
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
      status: 'OPEN',
      created_at: 0,
      updated_at: 0,
    },
  ];
}

function seedTrade(fixture: PaperDbFixture, id: string, status: TradeStatus, createdAt: number): void {
  fixture.tradeRepo.saveOpportunity(opportunity(`opp-${id}`));
  const t = trade(id, status, createdAt);
  fixture.tradeRepo.saveTrade(t);
  for (const leg of legs(id)) fixture.tradeRepo.saveTradeLeg(leg);
}

describe('getCurrentTrades — task 2.1', () => {
  let fixture: PaperDbFixture | undefined;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  it('orders alert-status trades first, then created_at descending within each group', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 'a', 'HEDGED', 1000);
    seedTrade(fixture, 'b', 'LEG_IMBALANCE', 500);
    seedTrade(fixture, 'c', 'HEDGED', 2000);

    const reader = openPaperDb(fixture.path)!;
    try {
      const result = getCurrentTrades(reader);
      expect(result.map((t) => t.trade_id)).toEqual(['b', 'c', 'a']);
    } finally {
      reader.close();
    }
  });

  it('excludes terminal-status trades (CLOSED/ABORTED/FAILED-no-wait: FAILED is an alert group, still non-terminal exclusion applies to CLOSED/ABORTED only... verify exclusion of CLOSED/ABORTED)', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 'open1', 'HEDGED', 1000);
    seedTrade(fixture, 'closed1', 'CLOSED', 2000);
    seedTrade(fixture, 'aborted1', 'ABORTED', 3000);

    const reader = openPaperDb(fixture.path)!;
    try {
      const result = getCurrentTrades(reader);
      expect(result.map((t) => t.trade_id)).toEqual(['open1']);
    } finally {
      reader.close();
    }
  });

  it('FAILED is both an alert status and terminal — excluded from current trades', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 'open1', 'HEDGED', 1000);
    seedTrade(fixture, 'failed1', 'FAILED', 2000);

    const reader = openPaperDb(fixture.path)!;
    try {
      const result = getCurrentTrades(reader);
      expect(result.map((t) => t.trade_id)).toEqual(['open1']);
    } finally {
      reader.close();
    }
  });

  it('returns { items: [] }-equivalent empty array when no trade is current', () => {
    fixture = createPaperDbFixture();
    const reader = openPaperDb(fixture.path)!;
    try {
      expect(getCurrentTrades(reader)).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it('derives long_exchange/short_exchange from legs, hedge_ratio from positions, unrealized_pnl_usdt from pnl_snapshots, funding_expected_usdt from funding_settlements', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 'a', 'HEDGED', 1000);

    fixture.orderRepo.savePosition({
      position_id: 'posL',
      trade_id: 'a',
      leg_id: 'a-L',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      position_side: 'LONG',
      quantity: 10,
      average_entry_price: 100,
      status: 'OPEN',
      opened_at: 1000,
      created_at: 1000,
      updated_at: 1000,
      base_quantity: 10,
      entry_filled_quantity: 10,
      exit_filled_quantity: 0,
      entry_notional_usdt: 1000,
      realized_price_pnl_usdt: 0,
      fees_usdt: 0.5,
      slippage_attribution_usdt: 0,
      applied_fill_ids: [],
    });
    fixture.orderRepo.savePosition({
      position_id: 'posS',
      trade_id: 'a',
      leg_id: 'a-S',
      exchange: 'Bybit',
      symbol: 'BTCUSDT',
      position_side: 'SHORT',
      quantity: 9,
      average_entry_price: 100.1,
      status: 'OPEN',
      opened_at: 1000,
      created_at: 1000,
      updated_at: 1000,
      base_quantity: 9,
      entry_filled_quantity: 9,
      exit_filled_quantity: 0,
      entry_notional_usdt: 900.9,
      realized_price_pnl_usdt: 0,
      fees_usdt: 0.45,
      slippage_attribution_usdt: 0,
      applied_fill_ids: [],
    });
    fixture.accountRepo.savePnlSnapshot({
      pnl_snapshot_id: 'pnl1',
      trade_id: 'a',
      snapshot_time: 1500,
      funding_pnl_usdt: 0.2,
      price_pnl_usdt: 1.0,
      fee_usdt: 0.95,
      unrealized_pnl_usdt: 1.2,
      net_pnl_usdt: 0.25,
      created_at: 1500,
      updated_at: 1500,
    });
    fixture.orderRepo.saveFundingSettlement({
      funding_id: 'f1',
      trade_id: 'a',
      leg_id: 'a-L',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      funding_time: 2000,
      position_notional: 1000,
      funding_rate: 0.0004,
      position_side: 'LONG',
      expected_cashflow_usdt: 0.4,
      settlement_status: 'EXPECTED',
      created_at: 1000,
      updated_at: 1000,
    });

    const reader = openPaperDb(fixture.path)!;
    try {
      const [summary] = getCurrentTrades(reader);
      expect(summary.long_exchange).toBe('Binance');
      expect(summary.short_exchange).toBe('Bybit');
      expect(summary.hedge_ratio).toBeCloseTo(9 / 10, 9);
      expect(summary.unrealized_pnl_usdt).toBeCloseTo(1.2, 9);
      expect(summary.funding_expected_usdt).toBeCloseTo(0.4, 9);
    } finally {
      reader.close();
    }
  });
});
