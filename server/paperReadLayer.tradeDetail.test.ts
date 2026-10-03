/**
 * server/paperReadLayer.tradeDetail.test.ts — task 2.3.
 *
 * Covers `getTradeDetail()`: open trade has no `result`, closed trade
 * includes `result`, unknown trade_id -> `undefined` (caller maps to 404).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPaperDbFixture, type PaperDbFixture } from './test/paperDbFixture';
import { getTradeDetail, openPaperDb } from './paperReadLayer';
import type { Fill, Opportunity, PaperOrder, Trade, TradeLeg, TradeResult } from '../runtime/src/types';

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

function trade(id: string, status: Trade['status']): Trade {
  return {
    trade_id: id,
    opportunity_id: `opp-${id}`,
    strategy_id: 's1',
    strategy_version: 'v1',
    config_version: 'c1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    created_at: 1000,
    updated_at: 1000,
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

function leg(tradeId: string, suffix: 'L' | 'S'): TradeLeg {
  return {
    leg_id: `${tradeId}-${suffix}`,
    trade_id: tradeId,
    exchange: suffix === 'L' ? 'Binance' : 'Bybit',
    symbol: 'BTCUSDT',
    direction: suffix === 'L' ? 'LONG' : 'SHORT',
    order_side: suffix === 'L' ? 'BUY' : 'SELL',
    leverage: 1,
    target_notional_usdt: 1000,
    target_quantity: 10,
    margin_allocated_usdt: 500,
    target_entry_price: 100,
    entry_order_ids: [],
    exit_order_ids: [],
    status: 'OPEN',
    created_at: 1000,
    updated_at: 1000,
  };
}

function order(tradeId: string, legId: string, id: string): PaperOrder {
  return {
    order_id: id,
    client_order_id: `c-${id}`,
    trade_id: tradeId,
    leg_id: legId,
    purpose: 'ENTRY',
    exchange: 'Binance',
    symbol: 'BTCUSDT',
    order_type: 'MARKET',
    side: 'BUY',
    position_side: 'LONG',
    reduce_only: false,
    requested_quantity: 10,
    requested_notional_usdt: 1000,
    reference_price: 100,
    order_state: 'FILLED',
    created_at: 1000,
    updated_at: 1000,
    filled_quantity: 10,
    remaining_quantity: 0,
    estimated_fee_usdt: 0.5,
    estimated_slippage_pct: 0.001,
  };
}

function fill(id: string, orderId: string, tradeId: string, legId: string): Fill {
  return {
    fill_id: id,
    order_id: orderId,
    trade_id: tradeId,
    leg_id: legId,
    exchange: 'Binance',
    timestamp: 1000,
    recorded_at: 1000,
    created_at: 1000,
    updated_at: 1000,
    quantity: 10,
    price: 100,
    notional_usdt: 1000,
    fee_usdt: 0.5,
    fee_asset: 'USDT',
    liquidity: 'TAKER',
    slippage_from_reference_pct: 0,
  };
}

function result(id: string): TradeResult {
  return {
    trade_id: id,
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    long_exchange: 'Binance',
    short_exchange: 'Bybit',
    target_notional_per_leg_usdt: 1000,
    actual_long_notional_usdt: 1000,
    actual_short_notional_usdt: 1000,
    leverage: 1,
    entry_duration_ms: 1000,
    exit_duration_ms: 1000,
    total_trade_duration_ms: 2000,
    funding_pnl_usdt: 1,
    price_pnl_usdt: 1,
    fee_usdt: 0.1,
    slippage_attribution_usdt: 0,
    net_pnl_usdt: 1.9,
    roi_on_capital_pct: 0.19,
    roi_on_notional_pct: 0.19,
    max_leg_imbalance_usdt: 0,
    max_leg_imbalance_duration_ms: 0,
    final_status: 'PROFIT',
    result_reason: 'PROFIT',
    finalized_at: 5000,
    funding_confirmed: true,
    created_at: 1000,
    updated_at: 5000,
  };
}

describe('getTradeDetail — task 2.3', () => {
  let fixture: PaperDbFixture | undefined;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  it('open trade: includes trade/legs/orders/fills/funding_settlements/opportunity, omits result', () => {
    fixture = createPaperDbFixture();
    fixture.tradeRepo.saveOpportunity(opportunity('opp-t1'));
    fixture.tradeRepo.saveTrade(trade('t1', 'HEDGED'));
    fixture.tradeRepo.saveTradeLeg(leg('t1', 'L'));
    fixture.tradeRepo.saveTradeLeg(leg('t1', 'S'));
    fixture.orderRepo.saveOrder(order('t1', 't1-L', 'o1'));
    fixture.orderRepo.saveFill(fill('f1', 'o1', 't1', 't1-L'));
    fixture.orderRepo.saveFundingSettlement({
      funding_id: 'fund1',
      trade_id: 't1',
      leg_id: 't1-L',
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
      const detail = getTradeDetail(reader, 't1')!;
      expect(detail).toBeDefined();
      expect(detail.trade.trade_id).toBe('t1');
      expect(detail.legs).toHaveLength(2);
      expect(detail.orders).toHaveLength(1);
      expect(detail.fills).toHaveLength(1);
      expect(detail.funding_settlements).toHaveLength(1);
      expect(detail.opportunity.opportunity_id).toBe('opp-t1');
      expect(detail.result).toBeUndefined();
      expect('result' in detail).toBe(false);
    } finally {
      reader.close();
    }
  });

  it('closed trade: includes result with trade_results row fields', () => {
    fixture = createPaperDbFixture();
    fixture.tradeRepo.saveOpportunity(opportunity('opp-t2'));
    fixture.tradeRepo.saveTrade(trade('t2', 'CLOSED'));
    fixture.tradeRepo.saveTradeLeg(leg('t2', 'L'));
    fixture.tradeRepo.saveTradeLeg(leg('t2', 'S'));
    fixture.insertTradeResult(result('t2'));

    const reader = openPaperDb(fixture.path)!;
    try {
      const detail = getTradeDetail(reader, 't2');
      expect(detail?.result).toBeDefined();
      expect(detail?.result?.final_status).toBe('PROFIT');
      expect(detail?.result?.finalized_at).toBe(5000);
    } finally {
      reader.close();
    }
  });

  it('unknown trade_id returns undefined (caller maps to 404)', () => {
    fixture = createPaperDbFixture();
    const reader = openPaperDb(fixture.path)!;
    try {
      expect(getTradeDetail(reader, 'does-not-exist')).toBeUndefined();
    } finally {
      reader.close();
    }
  });
});
