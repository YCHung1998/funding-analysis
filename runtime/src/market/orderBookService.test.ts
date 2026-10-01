import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import type { TradingEvent } from '../types/event';
import type { EventSink } from './instruments/types';
import { GuardedRestClient } from './http/guardedRestClient';
import { SourceStatusTracker } from './sourceStatus';
import { OrderBookService } from './orderBookService';
import type { MarketDataAdapter, OrderBookDelta, OrderBookSnapshot } from './types';

function setup() {
  const clock = new VirtualClock(0);
  const events: TradingEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push(e) };
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ bids: [[99, 1]], asks: [[101, 1]], seq: 200 }));
  const restClient = new GuardedRestClient({
    clock,
    eventSink: sink,
    rateLimitRules: { Bybit: [] } as any,
    sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
    fetchImpl,
  });
  const adapter: Pick<MarketDataAdapter, 'exchange' | 'rest'> = {
    exchange: 'Bybit',
    rest: {
      envelopeError: () => null,
      snapshotOrderBook: (symbol) => ({ exchange: 'Bybit', url: `https://api.bybit.com/v5/market/orderbook?symbol=${symbol}` }),
      parseOrderBookSnapshot: (body: any, symbol, local_received) => ({
        exchange: 'Bybit',
        symbol: `Bybit:${symbol}`,
        exchange_timestamp: local_received,
        local_received_timestamp: local_received,
        sequence: body.seq,
        bids: body.bids.map(([price, qty]: number[]) => ({ price, qty })),
        asks: body.asks.map(([price, qty]: number[]) => ({ price, qty })),
      }),
    },
  };
  const service = new OrderBookService({ clock, eventSink: sink, restClient, adapterFor: () => adapter });
  return { clock, events, service };
}

function snapshot(seq: number): OrderBookSnapshot {
  return {
    exchange: 'Bybit',
    symbol: 'Bybit:BTCUSDT',
    exchange_timestamp: 1,
    local_received_timestamp: 1,
    sequence: seq,
    bids: [{ price: 100, qty: 1 }],
    asks: [{ price: 101, qty: 1 }],
  };
}

function delta(partial: Partial<OrderBookDelta>): OrderBookDelta {
  return {
    exchange: 'Bybit',
    symbol: 'Bybit:BTCUSDT',
    exchange_timestamp: 2,
    local_received_timestamp: 2,
    sequence: 101,
    prev_sequence: 100,
    bids: [],
    asks: [],
    ...partial,
  };
}

describe('OrderBookService', () => {
  it('reports WARMING_UP before any snapshot', () => {
    const { service } = setup();
    expect(service.getOrderBook('Bybit:BTCUSDT').status).toBe('WARMING_UP');
  });

  it('triggers RESYNCING and ORDER_BOOK_RESYNC on a sequence gap', async () => {
    const { service, events, clock } = setup();
    service.applySnapshot(snapshot(100));
    service.applyDelta(delta({ sequence: 103, prev_sequence: 102 }), 50);
    expect(service.getOrderBook('Bybit:BTCUSDT').status).toBe('RESYNCING');
    expect(events.some((e) => e.event_type === 'ORDER_BOOK_RESYNC')).toBe(true);

    // 等待觸發時已啟動的非同步 REST 回補完成（resyncInFlight 守門避免重複請求）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getOrderBook('Bybit:BTCUSDT').status).toBe('OK');
    void clock;
  });

  it('ignores a duplicate (<=) delta without resyncing', () => {
    const { service, events } = setup();
    service.applySnapshot(snapshot(100));
    service.applyDelta(delta({ sequence: 99, prev_sequence: 98 }), 50);
    expect(service.getOrderBook('Bybit:BTCUSDT').status).toBe('OK');
    expect(events.some((e) => e.event_type === 'ORDER_BOOK_RESYNC')).toBe(false);
  });

  it('treats a crossed book (best bid >= best ask) as a gap', () => {
    const { service, events } = setup();
    service.applySnapshot(snapshot(100));
    service.applyDelta(delta({ sequence: 101, prev_sequence: 100, bids: [{ price: 102, qty: 1 }] }), 50);
    expect(service.getOrderBook('Bybit:BTCUSDT').status).toBe('RESYNCING');
    expect(events.some((e) => e.event_type === 'ORDER_BOOK_RESYNC')).toBe(true);
  });
});
