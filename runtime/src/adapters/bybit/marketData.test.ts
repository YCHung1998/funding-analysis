import { describe, expect, it } from 'vitest';
import { bybitMarketDataAdapter } from './marketData';

describe('bybitMarketDataAdapter', () => {
  it('parses the batched tickers response, including fundingIntervalHour and turnover24h', () => {
    const poll = bybitMarketDataAdapter.fullMarket[0];
    if (poll.kind !== 'POLL') throw new Error('expected POLL');
    const body = {
      time: 1790860747357,
      result: { list: [{ symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '101', markPrice: '100.5', indexPrice: '100.4', fundingRate: '0.0001', nextFundingTime: '1700006400000', fundingIntervalHour: '4', turnover24h: '123456' }] },
    };
    const events = poll.parse(body, 1790860747400);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ exchange: 'Bybit', symbol: 'Bybit:BTCUSDT', mark_price: 100.5, funding_rate: 0.0001, volume_24h_quote: 123456 });
  });

  it('acks a subscribe response', () => {
    const msgs = bybitMarketDataAdapter.ws!.parse(JSON.stringify({ op: 'subscribe', success: true, args: ['tickers.BTCUSDT'] }), 1);
    expect(msgs).toEqual([{ kind: 'ACK', topics: ['tickers.BTCUSDT'] }]);
  });

  it('parses an orderbook delta message', () => {
    const msgs = bybitMarketDataAdapter.ws!.parse(
      JSON.stringify({ topic: 'orderbook.50.BTCUSDT', type: 'delta', ts: 10, data: { b: [['100', '1']], a: [['101', '1']], u: 102 } }),
      11,
    );
    expect(msgs[0]).toMatchObject({ kind: 'BOOK_DELTA', delta: { sequence: 102, prev_sequence: 101 } });
  });

  it('classifies Bybit envelope error (retCode != 0)', () => {
    expect(bybitMarketDataAdapter.rest.envelopeError({ retCode: 10006, retMsg: 'rate limit' })).toContain('10006');
    expect(bybitMarketDataAdapter.rest.envelopeError({ retCode: 0 })).toBeNull();
  });
});
