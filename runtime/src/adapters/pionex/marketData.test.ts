import { describe, expect, it } from 'vitest';
import { pionexMarketDataAdapter } from './marketData';

describe('pionexMarketDataAdapter', () => {
  it('parses indexes into normalized events', () => {
    const poll = pionexMarketDataAdapter.fullMarket[0];
    if (poll.kind !== 'POLL') throw new Error('expected POLL');
    const events = poll.parse({ data: { indexes: [{ symbol: 'BTC_USDT_PERP', markPrice: '100', indexPrice: '99.9', nextFundingRate: '0.0001', nextFundingTime: 1700006400000, updateTime: 10 }] }, timestamp: 11 }, 12);
    expect(events[0]).toMatchObject({ symbol: 'Pionex:BTC_USDT_PERP', mark_price: 100, funding_rate: 0.0001, next_funding_time: 1700006400000 });
  });

  it('parses the depth timestamp field for queryServerTime', () => {
    const sample = pionexMarketDataAdapter.serverTime.parse({ timestamp: 1700000000000 });
    expect(sample).toBe(1700000000000);
  });
});
