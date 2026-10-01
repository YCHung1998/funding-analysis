/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * websocket-data-layer task 4.2 驗收：
 * 1. 行情就緒後，重複讀取記憶體狀態（等同 /api/market/live-scan 的查詢路徑）不產生任何上游呼叫。
 * 2. 某所斷路器開啟（HTTP 403/429 等）不影響其餘所的輪詢。
 *
 * server.ts 本身是可執行腳本（app.listen），這裡以同一組 websocket-data-layer 模組
 * （GuardedRestClient + MarketDataService + MarketState）組裝等價情境做單元 / 情境測試，
 * 不另外啟動 Express（見本 change 最終報告「50 併發測試」一節的範圍說明）。
 */
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/clock/virtualClock';
import type { TradingEvent } from '../../src/types/event';
import type { EventSink, InstrumentSnapshotInput } from '../../src/market/instruments/types';
import { InstrumentRegistry } from '../../src/market/instruments/registry';
import { GuardedRestClient } from '../../src/market/http/guardedRestClient';
import { SourceStatusTracker } from '../../src/market/sourceStatus';
import { MarketState } from '../../src/market/state/marketState';
import { OrderBookService } from '../../src/market/orderBookService';
import { MarketDataService } from '../../src/market/marketDataService';
import type { MarketDataAdapter, MarketDataEvent, PollFeedSpec, RateLimitRule } from '../../src/market/types';
import { createFakeWebSocketFactory } from '../../src/market/testDoubles/fakeWebSocket';

function makeInstrument(exchange: 'Bybit' | 'OKX', native_symbol: string): InstrumentSnapshotInput {
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
    status: 'TRADING',
    native_status: 'TRADING',
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

function makeAdapter(exchange: 'Bybit' | 'OKX'): { adapter: MarketDataAdapter; callCount: () => number } {
  let calls = 0;
  const poll: PollFeedSpec = {
    kind: 'POLL',
    name: 'tickers',
    interval_ms: 10_000,
    request: () => {
      calls += 1;
      return { exchange, url: `https://example.com/${exchange}/tickers` };
    },
    parse: (_body, local_received): MarketDataEvent[] => [
      {
        exchange,
        symbol: `${exchange}:BTCUSDT`,
        exchange_timestamp: local_received,
        local_received_timestamp: local_received,
        timestamp_source: 'RESPONSE',
        tier: 'FULL_MARKET',
        bid: null,
        ask: null,
        mark_price: 100,
        index_price: null,
        funding_rate: 0.0001,
      },
    ],
  };
  const adapter: MarketDataAdapter = {
    exchange,
    fullMarket: [poll],
    rest: {
      envelopeError: () => null,
      snapshotOrderBook: () => ({ exchange, url: 'https://x' }),
      parseOrderBookSnapshot: () => ({ exchange, symbol: '', exchange_timestamp: 0, local_received_timestamp: 0, bids: [], asks: [] }),
    },
    rateLimits: [{ name: 'per-sec', window_ms: 1000, limit: 100, unit: 'REQUESTS', block_statuses: [403], cooldown_ms: 600_000, verified: true }] as RateLimitRule[],
    serverTime: { request: () => ({ exchange, url: 'https://x' }), parse: () => 0 },
  };
  return { adapter, callCount: () => calls };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('live-scan isolation (task 4.2 acceptance)', () => {
  it('serves repeated reads with zero upstream calls once ready, and one exchange circuit-open does not block the other', async () => {
    const clock = new VirtualClock(0);
    const events: TradingEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Bybit', [makeInstrument('Bybit', 'BTCUSDT')], 0);
    registry.applySnapshot('OKX', [makeInstrument('OKX', 'BTCUSDT')], 0);

    const sourceStatus = new SourceStatusTracker({ eventSink: sink, now: () => clock.now() });

    let bybitShouldFail = true; // Bybit 403 → 斷路器開啟
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).includes('Bybit') && bybitShouldFail) return new Response('{}', { status: 403 });
      return new Response('{}', { status: 200 });
    };
    const { adapter: bybitAdapter, callCount: bybitUpstreamCalls } = makeAdapter('Bybit');
    const { adapter: okxAdapter, callCount: okxUpstreamCalls } = makeAdapter('OKX');

    const restClient = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Bybit: bybitAdapter.rateLimits, OKX: okxAdapter.rateLimits } as any,
      sourceStatus,
      fetchImpl,
    });
    const marketState = new MarketState({
      clock,
      eventSink: sink,
      sourceStatus,
      thresholds: { shortlist_threshold_ms: 3000, full_market_threshold_ms: 30000 },
      max_last_known_good_age_ms: 300000,
      freshness_check_interval_ms: 500,
    });
    const orderBook = new OrderBookService({ clock, eventSink: sink, restClient, adapterFor: () => bybitAdapter });
    const { factory } = createFakeWebSocketFactory();

    const service = new MarketDataService({
      clock,
      eventSink: sink,
      registry,
      restClient,
      marketState,
      orderBook,
      sourceStatus,
      wsFactory: factory,
      adapters: { Bybit: bybitAdapter, OKX: okxAdapter },
      scan_exchanges: ['Bybit', 'OKX'],
      trading_exchanges: [],
      reconnect_backoff: { base_ms: 1000, max_ms: 60000, jitter_ratio: 0 },
      backoff_reset_after_ms: 60000,
    });

    service.start();
    clock.advanceTo(0); // 觸發 t=0 的初始輪詢（VirtualClock 的 timer 需要明確 advanceTo 才會 fire）
    for (let i = 0; i < 10; i++) {
      await flush();
    }

    // Bybit 斷路器應已開啟（403），OKX 持續成功。
    expect(sourceStatus.get('Bybit')?.rate_limit?.circuit).toBe('OPEN');
    expect(sourceStatus.get('OKX')?.state).toBe('HEALTHY');
    const okxCallsAfterFirstRound = okxUpstreamCalls();
    expect(okxCallsAfterFirstRound).toBeGreaterThan(0);

    // 停用 fetch 計數追蹤後，模擬 50 個「請求路徑」讀取（純記憶體查詢，等同 live-scan 的查詢部分）。
    const bybitCallsBefore = bybitUpstreamCalls();
    const okxCallsBefore = okxUpstreamCalls();
    for (let i = 0; i < 50; i++) {
      registry.list().forEach((instrument) => marketState.getTicker(instrument.instrument_id));
    }
    expect(bybitUpstreamCalls()).toBe(bybitCallsBefore);
    expect(okxUpstreamCalls()).toBe(okxCallsBefore);

    // Bybit 斷路器開啟期間，OKX 的輪詢迴圈持續向前（未被阻塞）。
    clock.advanceTo(20_000);
    await flush();
    await flush();
    expect(okxUpstreamCalls()).toBeGreaterThan(okxCallsAfterFirstRound);
  });
});
