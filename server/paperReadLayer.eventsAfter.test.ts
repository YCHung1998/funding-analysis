/**
 * server/paperReadLayer.eventsAfter.test.ts — `paper-trading-event-stream` task 2.1.
 *
 * Covers `getEventsAfter()`: global (cross-trade) catch-up, `seq` ascending,
 * no `next_cursor` (design.md Decision 3 -- matches `GlobalEventsResponse`
 * in `contracts.ts` exactly).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPaperDbFixture, type PaperDbFixture } from './test/paperDbFixture';
import { getEventsAfter, openPaperDb } from './paperReadLayer';
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

describe('getEventsAfter — task 2.1', () => {
  let fixture: PaperDbFixture | undefined;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  function eventStore(f: PaperDbFixture): EventStore {
    return new EventStore(f.driver, { now: () => 0 });
  }

  it('returns events with seq 6-10 when after_seq=5 and events 1-10 exist', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    const store = eventStore(fixture);
    for (let i = 1; i <= 10; i += 1) {
      store.append({ event_id: `e${i}`, event_type: 'TRADE_STATUS_CHANGED', timestamp: i, trade_id: 't1', payload: {} });
    }

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getEventsAfter(reader, 5, 500);
      expect(page.items.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
      expect('next_cursor' in page).toBe(false);
    } finally {
      reader.close();
    }
  });

  it('returns an empty list when after_seq equals the current maximum seq', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    const store = eventStore(fixture);
    store.append({ event_id: 'e1', event_type: 'TRADE_STATUS_CHANGED', timestamp: 1, trade_id: 't1', payload: {} });

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getEventsAfter(reader, 1, 500);
      expect(page.items).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it('after_seq=0 behaves as every event up to limit', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    const store = eventStore(fixture);
    store.append({ event_id: 'e1', event_type: 'TRADE_STATUS_CHANGED', timestamp: 1, trade_id: 't1', payload: {} });
    store.append({ event_id: 'e2', event_type: 'TRADE_STATUS_CHANGED', timestamp: 2, trade_id: 't1', payload: {} });

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getEventsAfter(reader, 0, 500);
      expect(page.items.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    } finally {
      reader.close();
    }
  });

  it('truncates to limit', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    const store = eventStore(fixture);
    for (let i = 1; i <= 5; i += 1) {
      store.append({ event_id: `e${i}`, event_type: 'TRADE_STATUS_CHANGED', timestamp: i, trade_id: 't1', payload: {} });
    }

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getEventsAfter(reader, 0, 2);
      expect(page.items.map((e) => e.seq)).toEqual([1, 2]);
    } finally {
      reader.close();
    }
  });

  it('is global: returns events across multiple trades, ordered by seq', () => {
    fixture = createPaperDbFixture();
    seedTrade(fixture, 't1');
    seedTrade(fixture, 't2');
    const store = eventStore(fixture);
    store.append({ event_id: 'e1', event_type: 'TRADE_CREATED', timestamp: 1, trade_id: 't1', payload: {} });
    store.append({ event_id: 'e2', event_type: 'TRADE_CREATED', timestamp: 2, trade_id: 't2', payload: {} });
    store.append({ event_id: 'e3', event_type: 'TRADE_STATUS_CHANGED', timestamp: 3, trade_id: 't1', payload: {} });

    const reader = openPaperDb(fixture.path)!;
    try {
      const page = getEventsAfter(reader, 0, 500);
      expect(page.items.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3']);
      expect(page.items.map((e) => e.trade_id)).toEqual(['t1', 't2', 't1']);
    } finally {
      reader.close();
    }
  });
});
