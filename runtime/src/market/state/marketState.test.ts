import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../clock/virtualClock';
import type { TradingEvent } from '../../types/event';
import type { EventSink } from '../instruments/types';
import { SourceStatusTracker } from '../sourceStatus';
import { MarketState } from './marketState';
import type { MarketDataEvent } from '../types';

function setup(opts?: { shortlist_threshold_ms?: number; full_market_threshold_ms?: number; max_last_known_good_age_ms?: number }) {
  const clock = new VirtualClock(0);
  clock.setExchangeOffset('Binance', { offsetMs: 0, errorMs: 0, calibratedAt: 0 });
  clock.setExchangeOffset('Bybit', { offsetMs: 0, errorMs: 0, calibratedAt: 0 });
  clock.setExchangeOffset('OKX', { offsetMs: 0, errorMs: 0, calibratedAt: 0 });
  const events: TradingEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push(e) };
  const sourceStatus = new SourceStatusTracker({ eventSink: sink, now: () => clock.now() });
  const state = new MarketState({
    clock,
    eventSink: sink,
    sourceStatus,
    thresholds: { shortlist_threshold_ms: opts?.shortlist_threshold_ms ?? 3000, full_market_threshold_ms: opts?.full_market_threshold_ms ?? 30000 },
    max_last_known_good_age_ms: opts?.max_last_known_good_age_ms ?? 300000,
    freshness_check_interval_ms: 500,
  });
  return { clock, events, state, sourceStatus };
}

function tick(exchange: 'Binance' | 'Bybit' | 'OKX', symbol: string, exchange_timestamp: number, local_received_timestamp: number): MarketDataEvent {
  return {
    exchange,
    symbol,
    exchange_timestamp,
    local_received_timestamp,
    timestamp_source: 'EXCHANGE',
    tier: 'FULL_MARKET',
    bid: null,
    ask: null,
    mark_price: 100,
    index_price: null,
    funding_rate: 0.0001,
  };
}

describe('MarketState', () => {
  it('computes data_age_ms from the exchange clock offset', () => {
    const { clock, state } = setup();
    clock.setExchangeOffset('Binance', { offsetMs: 0, errorMs: 0, calibratedAt: 0 });
    state.upsert(tick('Binance', 'Binance:BTCUSDT', 9_956, 9_956));
    clock.setExchangeOffset('Binance', { offsetMs: 10_000, errorMs: 0, calibratedAt: 0 }); // exchangeNow('Binance') = now(0) + 10_000 = 10_000
    const fr = state.getFreshness('Binance:BTCUSDT');
    expect(fr.data_age_ms).toBe(44);
  });

  it('applies the shortlist threshold once promoted', () => {
    const { clock, state } = setup({ shortlist_threshold_ms: 3000, full_market_threshold_ms: 30000 });
    state.upsert(tick('Bybit', 'Bybit:BTCUSDT', 0, 0));
    state.markShortlisted('Bybit:BTCUSDT', true);
    clock.advanceTo(4000);
    const fr = state.getFreshness('Bybit:BTCUSDT');
    expect(fr.stale).toBe(true);
    expect(fr.threshold_ms).toBe(3000);
  });

  it('treats LOCAL timestamp_source as stale once shortlisted', () => {
    const { state } = setup();
    state.upsert({ ...tick('Bybit', 'Bybit:BTCUSDT', 0, 0), timestamp_source: 'LOCAL' });
    state.markShortlisted('Bybit:BTCUSDT', true);
    expect(state.getFreshness('Bybit:BTCUSDT').stale).toBe(true);
  });

  it('emits exactly one STALE_MARKET_DATA and one MARKET_DATA_RECOVERED per episode', () => {
    const { clock, state, events } = setup({ shortlist_threshold_ms: 3000 });
    state.upsert(tick('Bybit', 'Bybit:BTCUSDT', 0, 0));
    state.markShortlisted('Bybit:BTCUSDT', true);

    for (let i = 1; i <= 20; i++) {
      clock.advanceTo(i * 500);
      state.checkFreshnessOnce();
    }
    const staleEvents = events.filter((e) => e.event_type === 'STALE_MARKET_DATA');
    expect(staleEvents).toHaveLength(1);

    state.upsert(tick('Bybit', 'Bybit:BTCUSDT', 10_100, 10_100));
    clock.advanceTo(10_500);
    state.checkFreshnessOnce();
    const recoveredEvents = events.filter((e) => e.event_type === 'MARKET_DATA_RECOVERED');
    expect(recoveredEvents).toHaveLength(1);
  });

  it('emits a FEED-scoped STALE_MARKET_DATA when a polling exchange stops updating', () => {
    const { clock, state, events } = setup({ full_market_threshold_ms: 90000 });
    state.upsert(tick('OKX', 'OKX:BTC-USDT-SWAP', 0, 0));
    clock.advanceTo(100_000);
    state.checkFreshnessOnce();
    const feedStale = events.find((e) => e.event_type === 'STALE_MARKET_DATA' && (e.payload as any).scope === 'FEED');
    expect(feedStale).toBeDefined();
    expect(feedStale!.exchange).toBe('OKX');
  });

  it('merges fields across separate feeds for the same exchange instead of blanking them out', () => {
    // OKX 把 tickers / funding-rate / mark-price 拆成三個獨立 POLL feed；每個 feed 回傳的事件
    // 只填自己的欄位，其餘為 null。較新 feed 的 null 欄位不得沖掉較舊 feed 已寫入的值。
    const { state } = setup();
    state.upsert({ ...tick('OKX', 'OKX:BTC-USDT-SWAP', 10, 10), mark_price: null, funding_rate: null, bid: 100, ask: 101 });
    state.upsert({ ...tick('OKX', 'OKX:BTC-USDT-SWAP', 11, 11), mark_price: 99.5, funding_rate: null, bid: null, ask: null });
    state.upsert({ ...tick('OKX', 'OKX:BTC-USDT-SWAP', 12, 12), mark_price: null, funding_rate: 0.0002, bid: null, ask: null });

    const merged = state.getTicker('OKX:BTC-USDT-SWAP') as MarketDataEvent;
    expect(merged.bid).toBe(100);
    expect(merged.ask).toBe(101);
    expect(merged.mark_price).toBe(99.5);
    expect(merged.funding_rate).toBe(0.0002);
    expect(merged.exchange_timestamp).toBe(12); // 時間戳本身來自最新一次寫入
  });

  it('does not let an older snapshot overwrite newer stream data', () => {
    const { state } = setup();
    state.upsert(tick('Binance', 'Binance:BTCUSDT', 2000, 2000));
    state.upsert(tick('Binance', 'Binance:BTCUSDT', 1500, 2100));
    expect((state.getTicker('Binance:BTCUSDT') as MarketDataEvent).exchange_timestamp).toBe(2000);
  });

  it('keeps last-known-good data on partial failure, evicts after max age', () => {
    const { clock, state, sourceStatus } = setup({ max_last_known_good_age_ms: 300000 });
    state.upsert(tick('OKX', 'OKX:BTC-USDT-SWAP', 0, 0));
    sourceStatus.recordSuccess('OKX', 1);
    expect(state.getTicker('OKX:BTC-USDT-SWAP')).not.toBe('NOT_TRACKED');

    clock.advanceTo(300_001);
    state.checkFreshnessOnce();
    expect(state.getTicker('OKX:BTC-USDT-SWAP')).toBe('NOT_TRACKED');
    expect(sourceStatus.get('OKX')?.state).toBe('FAILED');
  });
});
