/**
 * server/paperReadLayer.tradeEvents.test.ts — task 3.1.
 *
 * Covers `getTradeEvents()`: `seq` ascending, keyset pagination (reusing
 * `paperCursor.ts`), unknown trade_id -> `undefined` (caller maps to 404),
 * malformed cursor -> `MalformedCursorError`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPaperDbFixture, type PaperDbFixture } from './test/paperDbFixture';
import { getTradeEvents, MalformedCursorError, openPaperDb } from './paperReadLayer';
import { EventStore } from '../runtime/src/storage/eventStore';
import type { Opportunity, Trade } from '../runtime/src/types';

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

function trade(id: string): Trade {
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
    status: 'HEDGED',
    target_notional_per_leg_usdt: 1000,
    leverage: 1,
    allocated_margin_usdt: 500,
    allocated_capital_usdt: 1000,
    legs: [],
    expected_pnl_usdt: 1,
    risk_status: RISK_PASS,
  };
}

function seedTrade(fixture: PaperDbFixture, id: string): void {
  fixture.tradeRepo.saveOpportunity(opportunity(`opp-${id}`));
  fixture.tradeRepo.saveTrade(trade(id));
}

describe('getTradeEvents — task 3.1', () => {
  let fixture: PaperDbFixture | undefined;
  let clockNow = 0;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  function eventStore(f: PaperDbFixture): EventStore {
    return new EventStore(f.driver, { now: () => clockNow });
  }

  it('orders events by seq ascending', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    const store = eventStore(fixture);
    clockNow = 10;
    store.append({ event_id: 'e1', event_type: 'TRADE_CREATED', timestamp: 10, trade_id: 't1', payload: {} });
    clockNow = 15;
    store.append({ event_id: 'e2', event_type: 'TRADE_STATUS_CHANGED', timestamp: 15, trade_id: 't1', payload: {} });
    clockNow = 22;
    store.append({ event_id: 'e3', event_type: 'TRADE_STATUS_CHANGED', timestamp: 22, trade_id: 't1', payload: {} });

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getTradeEvents(reader, 't1', null, 200)!;
      expect(page.items.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(page.items.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3']);
      expect(page.next_cursor).toBeNull();
    } finally {
      reader.close();
    }
  });

  it('paginates: second page items all have seq > first page last seq', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    const store = eventStore(fixture);
    for (let i = 0; i < 5; i += 1) {
      clockNow = i;
      store.append({ event_id: `e${i}`, event_type: 'TRADE_STATUS_CHANGED', timestamp: i, trade_id: 't1', payload: {} });
    }

    const reader = openPaperDb(fixture.path)!;
    try {
      const page1 = getTradeEvents(reader, 't1', null, 2)!;
      expect(page1.items).toHaveLength(2);
      expect(page1.items.map((e) => e.seq)).toEqual([1, 2]);
      expect(page1.next_cursor).not.toBeNull();

      const page2 = getTradeEvents(reader, 't1', page1.next_cursor, 2)!;
      expect(page2.items.every((e) => e.seq > 2)).toBe(true);
      expect(page2.items.map((e) => e.seq)).toEqual([3, 4]);
    } finally {
      reader.close();
    }
  });

  it('only returns events for the requested trade_id', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    seedTrade(fixture, 't2');
    const store = eventStore(fixture);
    store.append({ event_id: 'e1', event_type: 'TRADE_CREATED', timestamp: 1, trade_id: 't1', payload: {} });
    store.append({ event_id: 'e2', event_type: 'TRADE_CREATED', timestamp: 1, trade_id: 't2', payload: {} });

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getTradeEvents(reader, 't1', null, 200)!;
      expect(page.items.map((e) => e.event_id)).toEqual(['e1']);
    } finally {
      reader.close();
    }
  });

  it('returns undefined for an unknown trade_id', () => {
    fixture = createPaperDbFixture();
    const reader = openPaperDb(fixture.path)!;
    try {
      expect(getTradeEvents(reader, 'does-not-exist', null, 200)).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it('throws MalformedCursorError for an unparseable cursor', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    const reader = openPaperDb(fixture.path)!;
    try {
      expect(() => getTradeEvents(reader, 't1', 'not-valid-base64', 200)).toThrow(MalformedCursorError);
    } finally {
      reader.close();
    }
  });
});
