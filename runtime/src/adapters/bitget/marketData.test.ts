import { describe, expect, it } from 'vitest';
import { bitgetMarketDataAdapter } from './marketData';

describe('bitgetMarketDataAdapter', () => {
  it('parses tickers into normalized events', () => {
    const poll = bitgetMarketDataAdapter.fullMarket[0];
    if (poll.kind !== 'POLL') throw new Error('expected POLL');
    const events = poll.parse({ data: [{ symbol: 'BTCUSDT', markPrice: '100', fundingRate: '0.0001', usdtVolume: '5000', ts: '10' }] }, 11);
    expect(events[0]).toMatchObject({ symbol: 'Bitget:BTCUSDT', mark_price: 100, funding_rate: 0.0001, volume_24h_quote: 5000 });
  });

  it('marks rate limit rule as unverified (design.md Risks)', () => {
    expect(bitgetMarketDataAdapter.rateLimits[0].verified).toBe(false);
  });

  it('parses current-fund-rate into next_funding_time', () => {
    const poll = bitgetMarketDataAdapter.fullMarket[1];
    if (poll.kind !== 'POLL') throw new Error('expected POLL');
    const events = poll.parse({ data: [{ symbol: 'BTCUSDT', nextUpdate: '1700006400000', fundingRateInterval: '8' }] }, 5);
    expect(events[0].next_funding_time).toBe(1700006400000);
  });
});
