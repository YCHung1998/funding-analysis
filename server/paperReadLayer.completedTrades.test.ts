/**
 * server/paperReadLayer.completedTrades.test.ts — task 2.2.
 *
 * Covers `getCompletedTrades()`: first page / second page via cursor,
 * stability under a concurrent insert between pages (spec.md "Stable under
 * concurrent insert"), `final_status` filtering, and malformed cursor ->
 * `MalformedCursorError` (caller converts to 400).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPaperDbFixture, type PaperDbFixture } from './test/paperDbFixture';
import { getCompletedTrades, MalformedCursorError, openPaperDb } from './paperReadLayer';
import type { Opportunity, Trade, TradeResult } from '../runtime/src/types';

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

function trade(id: string, createdAt: number): Trade {
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
    status: 'CLOSED',
    target_notional_per_leg_usdt: 1000,
    leverage: 1,
    allocated_margin_usdt: 500,
    allocated_capital_usdt: 1000,
    legs: [],
    expected_pnl_usdt: 1,
    risk_status: RISK_PASS,
  };
}

function result(id: string, finalizedAt: number, finalStatus: TradeResult['final_status'] = 'PROFIT'): TradeResult {
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
    final_status: finalStatus,
    result_reason: finalStatus,
    finalized_at: finalizedAt,
    funding_confirmed: true,
    created_at: finalizedAt - 1000,
    updated_at: finalizedAt,
  };
}

function seedCompletedTrade(
  fixture: PaperDbFixture,
  id: string,
  finalizedAt: number,
  finalStatus: TradeResult['final_status'] = 'PROFIT',
): void {
  fixture.tradeRepo.saveOpportunity(opportunity(`opp-${id}`));
  fixture.tradeRepo.saveTrade(trade(id, finalizedAt - 1000));
  fixture.insertTradeResult(result(id, finalizedAt, finalStatus));
}

describe('getCompletedTrades — task 2.2', () => {
  let fixture: PaperDbFixture | undefined;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  it('first page: 75 trades, limit 50 -> 50 items, non-null next_cursor, most recently finalized first', () => {
    fixture = createPaperDbFixture();
    for (let i = 0; i < 75; i += 1) {
      seedCompletedTrade(fixture, `t${i}`, 1000 + i);
    }

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getCompletedTrades(reader, {}, null, 50);
      expect(page.items).toHaveLength(50);
      expect(page.next_cursor).not.toBeNull();
      expect(page.items[0].trade_id).toBe('t74');
      expect(page.items[49].trade_id).toBe('t25');
    } finally {
      reader.close();
    }
  });

  it('second page via cursor: remaining 25 items, next_cursor null', () => {
    fixture = createPaperDbFixture();
    for (let i = 0; i < 75; i += 1) {
      seedCompletedTrade(fixture, `t${i}`, 1000 + i);
    }

    const reader = openPaperDb(fixture.path)!;
    try {
      const page1 = getCompletedTrades(reader, {}, null, 50);
      const page2 = getCompletedTrades(reader, {}, page1.next_cursor, 50);
      expect(page2.items).toHaveLength(25);
      expect(page2.next_cursor).toBeNull();
      expect(page2.items[0].trade_id).toBe('t24');
      expect(page2.items[24].trade_id).toBe('t0');
    } finally {
      reader.close();
    }
  });

  it('stable under concurrent insert: page 2 unaffected by a trade finalized after page 1 was fetched', () => {
    fixture = createPaperDbFixture();
    for (let i = 0; i < 50; i += 1) {
      seedCompletedTrade(fixture, `t${i}`, 1000 + i);
    }

    const reader = openPaperDb(fixture.path)!;
    try {
      const page1 = getCompletedTrades(reader, {}, null, 50 - 50 + 25); // first 25 of the 50
      // Simulate the Runtime finalizing a brand-new trade after page 1 was fetched.
      seedCompletedTrade(fixture, 'new-trade', 999_999);

      const page2 = getCompletedTrades(reader, {}, page1.next_cursor, 25);
      expect(page2.items.map((t) => t.trade_id)).not.toContain('new-trade');
      expect(page2.items).toHaveLength(25);
    } finally {
      reader.close();
    }
  });

  it('filters by final_status', () => {
    fixture = createPaperDbFixture();
    seedCompletedTrade(fixture, 'p1', 1000, 'PROFIT');
    seedCompletedTrade(fixture, 'e1', 2000, 'EMERGENCY_EXIT');
    seedCompletedTrade(fixture, 'p2', 3000, 'PROFIT');

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getCompletedTrades(reader, { final_status: 'EMERGENCY_EXIT' }, null, 50);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].result.final_status).toBe('EMERGENCY_EXIT');
    } finally {
      reader.close();
    }
  });

  it('throws MalformedCursorError for an unparseable cursor', () => {
    fixture = createPaperDbFixture();
    const reader = openPaperDb(fixture.path)!;
    try {
      expect(() => getCompletedTrades(reader, {}, 'not-valid-base64', 50)).toThrow(MalformedCursorError);
    } finally {
      reader.close();
    }
  });
});
