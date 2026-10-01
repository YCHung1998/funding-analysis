import { describe, expect, it } from 'vitest';
import { okxMarketDataAdapter } from './marketData';

describe('okxMarketDataAdapter', () => {
  it('parses mark-price poll (verified endpoint, task 3.3)', () => {
    const poll = okxMarketDataAdapter.fullMarket[2];
    if (poll.kind !== 'POLL') throw new Error('expected POLL');
    const events = poll.parse({ data: [{ instId: 'BTC-USDT-SWAP', markPx: '100.5', ts: '10' }] }, 11);
    expect(events[0]).toMatchObject({ symbol: 'OKX:BTC-USDT-SWAP', mark_price: 100.5, exchange_timestamp: 10 });
  });

  it('classifies a non-zero OKX code as an envelope error', () => {
    expect(okxMarketDataAdapter.rest.envelopeError({ code: '50011', msg: 'x' })).toContain('50011');
    expect(okxMarketDataAdapter.rest.envelopeError({ code: '0' })).toBeNull();
  });
});
