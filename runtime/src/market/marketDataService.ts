/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 兩層協調（design.md Decision 4，market-data-stream spec「Full-market tier
 * coverage」「Full-market tier follows registry changes」「Shortlist tier
 * promotion and release」）。全市場層依 `subscribableSymbols` 啟動並跟隨
 * `onChange`；入圍層由 `promote` / `release` 驅動，參照計數。
 */
import type { Clock, TimerHandle } from '../clock/types';
import type { ExchangeId } from '../types/ids';
import type { InstrumentRegistry } from './instruments/registry';
import type { EventSink, RegistryDiff } from './instruments/types';
import { GuardedRestClient } from './http/guardedRestClient';
import { MarketState } from './state/marketState';
import { OrderBookService } from './orderBookService';
import { SourceStatusTracker } from './sourceStatus';
import { ConnectionPool } from './stream/connectionPool';
import { WsConnection } from './stream/wsConnection';
import { forwardFundingSchedule } from './fundingService';
import type { BackoffConfig } from './backoff';
import type { MarketDataEvent, MarketDataAdapter, PromoteItemResult, PromoteResult, WebSocketFactory } from './types';
import type { RestRequest } from './http/publicRestClient';

export interface MarketDataServiceDeps {
  clock: Clock;
  eventSink: EventSink;
  registry: InstrumentRegistry;
  restClient: GuardedRestClient;
  marketState: MarketState;
  orderBook: OrderBookService;
  sourceStatus: SourceStatusTracker;
  wsFactory: WebSocketFactory;
  adapters: Partial<Record<ExchangeId, MarketDataAdapter>>;
  scan_exchanges: ExchangeId[];
  trading_exchanges: ExchangeId[];
  reconnect_backoff: BackoffConfig;
  backoff_reset_after_ms: number;
}

function instrumentIdExchange(instrument_id: string): ExchangeId {
  return instrument_id.split(':')[0] as ExchangeId;
}

function instrumentIdNativeSymbol(instrument_id: string): string {
  return instrument_id.split(':').slice(1).join(':');
}

export class MarketDataService {
  private readonly pollTimers = new Map<string, TimerHandle>();
  private readonly streamConnections = new Map<string, WsConnection>();
  private readonly shortlistPools = new Map<ExchangeId, ConnectionPool>();
  /** instrument_id -> 入圍它的 session_id 集合（參照計數）。 */
  private readonly shortlistRefs = new Map<string, Set<string>>();
  private readonly startupSnapshotDone = new Set<ExchangeId>();
  private started = false;

  constructor(private readonly deps: MarketDataServiceDeps) {
    this.deps.registry.onChange((diff) => this.onRegistryChange(diff));
  }

  // ---- 啟動：全市場層 --------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const exchange of this.deps.scan_exchanges) {
      const adapter = this.deps.adapters[exchange];
      if (!adapter) continue;
      for (const feed of adapter.fullMarket) {
        if (feed.kind === 'POLL') {
          const request = feed.request;
          const parse = feed.parse;
          this.startPollLoop(exchange, feed.name, feed.interval_ms, request, parse);
        } else {
          this.startFullMarketStream(exchange, feed);
        }
      }
    }
  }

  isReady(): boolean {
    return this.deps.scan_exchanges.every((ex) => this.startupSnapshotDone.has(ex));
  }

  private trackSuccess(exchange: ExchangeId, events: MarketDataEvent[]): void {
    const subscribable = new Set(this.deps.registry.subscribableSymbols(exchange));
    let applied = 0;
    const now = this.deps.clock.now();
    for (const event of events) {
      const nativeSymbol = instrumentIdNativeSymbol(event.symbol);
      if (!subscribable.has(nativeSymbol)) continue; // 僅追蹤 registry 可訂閱合約
      this.deps.marketState.upsert(event);
      forwardFundingSchedule(this.deps.registry, event, nativeSymbol, now);
      applied += 1;
    }
    this.startupSnapshotDone.add(exchange);
    this.deps.sourceStatus.recordSuccess(exchange, this.deps.marketState.instrumentCount(exchange));
    void applied;
  }

  private startPollLoop(
    exchange: ExchangeId,
    feedName: string,
    intervalMs: number,
    request: () => RestRequest,
    parse: (body: unknown, local_received: number) => MarketDataEvent[],
  ): void {
    const key = `${exchange}:${feedName}`;
    const run = async (): Promise<void> => {
      try {
        const req = request();
        const result = await this.deps.restClient.getJson<unknown>(req);
        const events = parse(result.data, result.local_received);
        this.trackSuccess(exchange, events);
      } catch {
        // GuardedRestClient 已記錄 SourceStatus 失敗（含最後成功資料保留）；
        // 此處不吞錯亦不中斷迴圈（BE-05：每所獨立）。
      }
      const multiplier = this.deps.restClient.rateLimiter(exchange).pollIntervalMultiplier();
      this.pollTimers.set(key, this.deps.clock.after(intervalMs * multiplier, () => void run()));
    };
    this.pollTimers.set(key, this.deps.clock.after(0, () => void run()));
  }

  private startFullMarketStream(exchange: ExchangeId, feed: Extract<MarketDataAdapter['fullMarket'][number], { kind: 'STREAM' }>): void {
    const key = `${exchange}:${feed.name}`;
    const conn = new WsConnection({
      clock: this.deps.clock,
      eventSink: this.deps.eventSink,
      exchange,
      connection_id: key,
      wsFactory: this.deps.wsFactory,
      url: feed.url,
      heartbeat: feed.heartbeat,
      parse: feed.parse,
      buildSubscribe: feed.buildSubscribe ?? (() => ''),
      buildUnsubscribe: feed.buildUnsubscribe ?? (() => ''),
      onMessage: (msgs) => {
        const events: MarketDataEvent[] = [];
        for (const m of msgs) if (m.kind === 'TICKER') events.push(m.event);
        this.trackSuccess(exchange, events);
      },
      backoff: this.deps.reconnect_backoff,
      backoff_reset_after_ms: this.deps.backoff_reset_after_ms,
    });
    this.streamConnections.set(key, conn);
    conn.connect(feed.topics ?? []);
  }

  // ---- 註冊表變動 --------------------------------------------------

  private onRegistryChange(_diff: RegistryDiff): void {
    for (const exchange of this.deps.scan_exchanges) {
      const subscribable = new Set(this.deps.registry.subscribableSymbols(exchange));

      // 入圍層：不再可訂閱的合約立即取消入圍訂閱並發 SHORTLIST_SUBSCRIPTION_DROPPED。
      for (const instrumentId of [...this.shortlistRefs.keys()]) {
        if (instrumentIdExchange(instrumentId) !== exchange) continue;
        if (!subscribable.has(instrumentIdNativeSymbol(instrumentId))) {
          this.dropShortlist(instrumentId, 'INSTRUMENT_NOT_SUBSCRIBABLE');
        }
      }

      // 全市場層：不再可訂閱的合約立即自行情狀態移除。
      for (const instrumentId of this.deps.marketState.instrumentIdsForExchange(exchange)) {
        if (!subscribable.has(instrumentIdNativeSymbol(instrumentId))) this.deps.marketState.remove(instrumentId);
      }
    }
  }

  private dropShortlist(instrument_id: string, reason: string): void {
    this.shortlistRefs.delete(instrument_id);
    this.deps.marketState.markShortlisted(instrument_id, false);
    this.deps.eventSink.emit({
      event_id: crypto.randomUUID(),
      event_type: 'SHORTLIST_SUBSCRIPTION_DROPPED',
      timestamp: this.deps.clock.now(),
      recorded_at: this.deps.clock.now(),
      exchange: instrumentIdExchange(instrument_id),
      symbol: instrument_id,
      trade_id: null,
      payload: { reason },
    });
  }

  // ---- 入圍層 --------------------------------------------------

  promote(session_id: string, instrument_ids: string[]): PromoteResult {
    const results: PromoteItemResult[] = [];
    for (const instrumentId of instrument_ids) {
      const exchange = instrumentIdExchange(instrumentId);
      if (!this.deps.trading_exchanges.includes(exchange)) {
        results.push({ instrument_id: instrumentId, status: 'REJECTED_NOT_TRADING_EXCHANGE' });
        continue;
      }
      const native = instrumentIdNativeSymbol(instrumentId);
      const subscribable = new Set(this.deps.registry.subscribableSymbols(exchange));
      if (!subscribable.has(native)) {
        results.push({ instrument_id: instrumentId, status: 'REJECTED_NOT_SUBSCRIBABLE' });
        continue;
      }

      const sessions = this.shortlistRefs.get(instrumentId) ?? new Set<string>();
      const isNew = sessions.size === 0;
      sessions.add(session_id);
      this.shortlistRefs.set(instrumentId, sessions);
      this.deps.marketState.markShortlisted(instrumentId, true);

      if (isNew) this.subscribeShortlist(exchange, native, instrumentId);
      results.push({ instrument_id: instrumentId, status: 'OK' });
    }
    return { results };
  }

  release(session_id: string): void {
    for (const [instrumentId, sessions] of [...this.shortlistRefs.entries()]) {
      if (!sessions.has(session_id)) continue;
      sessions.delete(session_id);
      if (sessions.size === 0) this.unsubscribeShortlist(instrumentId);
      else this.shortlistRefs.set(instrumentId, sessions);
    }
  }

  releaseInstruments(session_id: string, instrument_ids: string[]): void {
    for (const instrumentId of instrument_ids) {
      const sessions = this.shortlistRefs.get(instrumentId);
      if (!sessions?.has(session_id)) continue;
      sessions.delete(session_id);
      if (sessions.size === 0) this.unsubscribeShortlist(instrumentId);
    }
  }

  private subscribeShortlist(exchange: ExchangeId, native_symbol: string, instrument_id: string): void {
    const adapter = this.deps.adapters[exchange];
    if (!adapter?.shortlist || !adapter.ws) return;
    const pool = this.poolFor(exchange, adapter);
    pool.subscribe(adapter.shortlist.topicsFor(native_symbol));
    void instrument_id; // WARMING_UP 直到第一份快照（由 marketState.getFreshness 經 getTicker 'NOT_TRACKED' 反映）
  }

  private unsubscribeShortlist(instrument_id: string): void {
    this.shortlistRefs.delete(instrument_id);
    this.deps.marketState.markShortlisted(instrument_id, false);
    // 簡化：目前實作不主動送出 UNSUBSCRIBE 訊框（多場次共用連線情境下的部分取消訂閱，留待後續強化）。
  }

  private poolFor(exchange: ExchangeId, adapter: MarketDataAdapter): ConnectionPool {
    let pool = this.shortlistPools.get(exchange);
    if (!pool) {
      pool = new ConnectionPool({
        clock: this.deps.clock,
        eventSink: this.deps.eventSink,
        exchange,
        wsFactory: this.deps.wsFactory,
        url: adapter.ws!.url,
        heartbeat: adapter.ws!.heartbeat,
        parse: adapter.ws!.parse,
        buildSubscribe: adapter.ws!.buildSubscribe,
        buildUnsubscribe: adapter.ws!.buildUnsubscribe,
        onMessage: (msgs) => {
          for (const m of msgs) {
            if (m.kind === 'TICKER') this.deps.marketState.upsert(m.event);
            else if (m.kind === 'BOOK_SNAPSHOT') this.deps.orderBook.applySnapshot(m.snapshot);
            else if (m.kind === 'BOOK_DELTA') this.deps.orderBook.applyDelta(m.delta, adapter.shortlist?.book.depth ?? 50);
          }
        },
        onReconnected: (topics) => void topics, // 回補由呼叫端監看 getFreshness/getOrderBook 的 stale 狀態觀察
        backoff: this.deps.reconnect_backoff,
        backoff_reset_after_ms: this.deps.backoff_reset_after_ms,
        max_topics_per_connection: adapter.ws!.max_topics_per_connection,
        max_connection_lifetime_ms: adapter.ws!.max_connection_lifetime_ms,
      });
      this.shortlistPools.set(exchange, pool);
    }
    return pool;
  }
}
