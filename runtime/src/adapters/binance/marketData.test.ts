import { describe, expect, it } from 'vitest';
import { binanceMarketDataAdapter } from './marketData';

describe('binanceMarketDataAdapter', () => {
  it('parses a !markPrice@arr tick into a normalized MarketDataEvent', () => {
    const stream = binanceMarketDataAdapter.fullMarket[0];
    if (stream.kind !== 'STREAM') throw new Error('expected STREAM feed');
    const raw = JSON.stringify([{ e: 'markPriceUpdate', s: 'BTCUSDT', E: 1700000000120, p: '83000.1', i: '82990.5', r: '0.00010000', T: 1700006400000 }]);
    const msgs = stream.parse(raw, 1700000000164);
    expect(msgs).toHaveLength(1);
    const msg = msgs[0];
    if (msg.kind !== 'TICKER') throw new Error('expected TICKER');
    expect(msg.event).toEqual({
      exchange: 'Binance',
      symbol: 'Binance:BTCUSDT',
      exchange_timestamp: 1700000000120,
      local_received_timestamp: 1700000000164,
      timestamp_source: 'EXCHANGE',
      tier: 'FULL_MARKET',
      bid: null,
      ask: null,
      mark_price: 83000.1,
      index_price: 82990.5,
      funding_rate: 0.0001,
      next_funding_time: 1700006400000,
    });
  });

  it('keeps missing markPrice as null instead of defaulting', () => {
    const stream = binanceMarketDataAdapter.fullMarket[0];
    if (stream.kind !== 'STREAM') throw new Error('expected STREAM feed');
    const raw = JSON.stringify([{ s: 'ETHUSDT', E: 1 }]);
    const msgs = stream.parse(raw, 2);
    if (msgs[0].kind !== 'TICKER') throw new Error('expected TICKER');
    expect(msgs[0].event.mark_price).toBeNull();
  });

  it('parses a bookTicker shortlist message', () => {
    const raw = JSON.stringify({ stream: 'btcusdt@bookTicker', data: { s: 'BTCUSDT', b: '100.1', a: '100.2', E: 10 } });
    const msgs = binanceMarketDataAdapter.ws!.parse(raw, 11);
    expect(msgs[0]).toMatchObject({ kind: 'TICKER', event: { bid: 100.1, ask: 100.2, tier: 'SHORTLIST' } });
  });

  it('builds a depth REST snapshot request and parses the response', () => {
    const req = binanceMarketDataAdapter.rest.snapshotOrderBook('BTCUSDT', 20);
    expect(req.url).toContain('depth?symbol=BTCUSDT&limit=20');
    const snapshot = binanceMarketDataAdapter.rest.parseOrderBookSnapshot(
      { lastUpdateId: 5, bids: [['100', '1']], asks: [['101', '1']] },
      'BTCUSDT',
      999,
    );
    expect(snapshot.sequence).toBe(5);
    expect(snapshot.bids).toEqual([{ price: 100, qty: 1 }]);
  });
});
