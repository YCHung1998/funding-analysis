/**
 * runtime/src/storage/marketDataRepository.test.ts
 *
 * Task 2.2 — `market_events` / `funding_rates` tables + repository
 * (proposal.md: "不寫入市場資料內容...只建表 + repository，寫入者為
 * `market-data-stream`" — this change only owns table + round trip).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from './driver';
import { migrate } from './migrate';
import { migration001 } from './migrations/001_initial';
import { createMarketDataRepository, type MarketDataRepository, type MarketEventRow, type FundingRateRow } from './marketDataRepository';
import { tmpDriver } from './test-helpers';

describe('marketDataRepository', () => {
  let db: NodeSqliteDriver;
  let repo: MarketDataRepository;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001]);
    repo = createMarketDataRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('MarketEvent round trips losslessly', () => {
    const event: MarketEventRow = {
      market_event_id: 'me1',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      event_type: 'TICKER',
      exchange_timestamp: 1,
      local_received_timestamp: 2,
      sequence: 1,
      payload: { price: 100 },
      created_at: 2,
    };
    repo.saveMarketEvent(event);
    expect(repo.listMarketEvents({ exchange: 'Binance', symbol: 'BTCUSDT' })).toEqual([event]);
  });

  it('FundingRate round trips losslessly', () => {
    const rate: FundingRateRow = {
      funding_rate_id: 'fr1',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      funding_rate: 0.0001,
      funding_time: 10,
      interval_hours: 8,
      recorded_at: 1,
      created_at: 1,
    };
    repo.saveFundingRate(rate);
    expect(repo.listFundingRates({ exchange: 'Binance', symbol: 'BTCUSDT' })).toEqual([rate]);
  });

  it('exposes no delete method', () => {
    const methodNames = Object.keys(repo);
    expect(methodNames.some((name) => /delete/i.test(name))).toBe(false);
  });
});
