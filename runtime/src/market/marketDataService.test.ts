import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import type { TradingEvent } from '../types/event';
import type { EventSink, InstrumentSnapshotInput } from './instruments/types';
import { InstrumentRegistry } from './instruments/registry';
import { GuardedRestClient } from './http/guardedRestClient';
import { SourceStatusTracker } from './sourceStatus';
import { MarketState } from './state/marketState';
import { OrderBookService } from './orderBookService';
import { MarketDataService } from './marketDataService';
import type { MarketDataAdapter, MarketDataEvent, PollFeedSpec } from './types';
import { createFakeWebSocketFactory } from './testDoubles/fakeWebSocket';

function makeInstrument(exchange: 'Bybit' | 'Pionex' | 'Binance', native_symbol: string, status: 'TRADING' | 'DELISTING' = 'TRADING'): InstrumentSnapshotInput {
  return {
    instrument_id: `${exchange}:${native_symbol}`,
    exchange,
    native_symbol,
    instrument_key: `${native_symbol}/USDT:USDT`,
    base_asset: native_symbol.replace('USDT', ''),
    quote_asset: 'USDT',
    settle_asset: 'USDT',
    listed_base_asset: native_symbol.replace('USDT', ''),
    price_multiplier: 1,
    qty_unit_in_base: 1,
    multiplier_source: 'NONE',
    contract_type: 'LINEAR_PERPETUAL',
    native_contract_type: 'PERPETUAL',
    status,
    native_status: status,
    tick_size: 0.1,
    qty_step: 0.001,
    min_qty: 0.001,
    min_notional: null,
    funding: {
      next_funding_time: null,
      funding_interval_hours: 8,
      interval_source: 'EXCHANGE_DOC_DEFAULT',
      schedule_status: 'MISSING',
      exchange_timestamp: null,
      local_received_timestamp: null,
      updated_at: 0,
    },
  };
}

function makePollAdapter(exchange: 'Bybit' | 'Pionex', intervalMs: number, callLog: number[]): MarketDataAdapter {
  const poll: PollFeedSpec = {
    kind: 'POLL',
    name: 'tickers',
    interval_ms: intervalMs,
    request: () => ({ exchange, url: `https://example.com/${exchange}/tickers` }),
    parse: (): MarketDataEvent[] => {
      callLog.push(1);
      return [];
    },
  };
  return {
    exchange,
    fullMarket: [poll],
    rest: {
      envelopeError: () => null,
      snapshotOrderBook: () => ({ exchange, url: 'https://x' }),
      parseOrderBookSnapshot: () => ({ exchange, symbol: '', exchange_timestamp: 0, local_received_timestamp: 0, bids: [], asks: [] }),
    },
    rateLimits: [],
    serverTime: { request: () => ({ exchange, url: 'https://x' }), parse: () => 0 },
  };
}

function setup() {
  const clock = new VirtualClock(0);
  const events: TradingEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push(e) };
  const registry = new InstrumentRegistry(sink);
  registry.applySnapshot('Bybit', [makeInstrument('Bybit', 'BTCUSDT')], 0);
  registry.applySnapshot('Pionex', [makeInstrument('Pionex', 'BTC_USDT_PERP')], 0);

  const sourceStatus = new SourceStatusTracker({ eventSink: sink, now: () => clock.now() });
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify([]));
  const restClient = new GuardedRestClient({ clock, eventSink: sink, rateLimitRules: {} as any, sourceStatus, fetchImpl });
  const marketState = new MarketState({
    clock,
    eventSink: sink,
    sourceStatus,
    thresholds: { shortlist_threshold_ms: 3000, full_market_threshold_ms: 30000 },
    max_last_known_good_age_ms: 300000,
    freshness_check_interval_ms: 500,
  });
  const orderBook = new OrderBookService({ clock, eventSink: sink, restClient, adapterFor: () => ({ exchange: 'Bybit', rest: {} as any }) });
  const { factory } = createFakeWebSocketFactory();

  const bybitCalls: number[] = [];
  const pionexCalls: number[] = [];

  const service = new MarketDataService({
    clock,
    eventSink: sink,
    registry,
    restClient,
    marketState,
    orderBook,
    sourceStatus,
    wsFactory: factory,
    adapters: { Bybit: makePollAdapter('Bybit', 10_000, bybitCalls), Pionex: makePollAdapter('Pionex', 30_000, pionexCalls) },
    scan_exchanges: ['Bybit', 'Pionex'],
    trading_exchanges: ['Bybit'],
    reconnect_backoff: { base_ms: 1000, max_ms: 60000, jitter_ratio: 0 },
    backoff_reset_after_ms: 60000,
  });

  return { clock, events, registry, service, bybitCalls, pionexCalls, marketState };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MarketDataService', () => {
  it('polls each exchange at its own adapter-declared interval', async () => {
    const { clock, service, bybitCalls, pionexCalls } = setup();
    service.start();
    // VirtualClock.advanceTo() fires due timers synchronously but each poll loop's next
    // `clock.after(...)` registration happens only after its fetch promise resolves — so the
    // clock must be advanced in small steps with microtask flushes interleaved, mirroring how
    // real time and real async I/O interleave.
    for (let t = 0; t <= 29_000; t += 1000) {
      clock.advanceTo(t);
      await flush();
    }
    expect(bybitCalls.length).toBe(3); // t=0,10s,20s
    expect(pionexCalls.length).toBe(1); // t=0
  });

  it('rejects promote for a scan-only (non trading_exchange) instrument', () => {
    const { service } = setup();
    const result = service.promote('S1', ['Pionex:BTC_USDT_PERP']);
    expect(result.results).toEqual([{ instrument_id: 'Pionex:BTC_USDT_PERP', status: 'REJECTED_NOT_TRADING_EXCHANGE' }]);
  });

  it('shares one subscription across sessions via reference counting', () => {
    const { service, marketState } = setup();
    const r1 = service.promote('S1', ['Bybit:BTCUSDT']);
    expect(r1.results[0].status).toBe('OK');
    expect(marketState.isShortlisted('Bybit:BTCUSDT')).toBe(true);

    service.promote('S2', ['Bybit:BTCUSDT']);
    service.release('S1');
    expect(marketState.isShortlisted('Bybit:BTCUSDT')).toBe(true); // S2 仍在

    service.release('S2');
    expect(marketState.isShortlisted('Bybit:BTCUSDT')).toBe(false);
  });

  it('removes a delisted instrument from market state on the next registry change', () => {
    const { registry, service, marketState } = setup();
    service.start();
    marketState.upsert({
      exchange: 'Bybit',
      symbol: 'Bybit:BTCUSDT',
      exchange_timestamp: 1,
      local_received_timestamp: 1,
      timestamp_source: 'EXCHANGE',
      tier: 'FULL_MARKET',
      bid: null,
      ask: null,
      mark_price: 1,
      index_price: null,
      funding_rate: null,
    });
    expect(marketState.getTicker('Bybit:BTCUSDT')).not.toBe('NOT_TRACKED');

    registry.applySnapshot('Bybit', [makeInstrument('Bybit', 'BTCUSDT', 'DELISTING')], 1);
    expect(marketState.getTicker('Bybit:BTCUSDT')).toBe('NOT_TRACKED');
  });
});
