/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 行情狀態（最新值表）與新鮮度排程（market-data-stream spec「Normalized market
 * data」「Data freshness」「Stale market data transitions emit events」，
 * market-data-snapshot spec「Last-known-good data is never overwritten by
 * failures」）。計時經由注入的 Clock（架構守門：不得 Date.now/setTimeout/setInterval）。
 */
import type { Clock, TimerHandle } from '../../clock/types';
import type { ExchangeId } from '../../types/ids';
import type { EventSink } from '../instruments/types';
import { SourceStatusTracker } from '../sourceStatus';
import { computeFreshness, type FreshnessThresholds } from './freshness';
import type { Freshness, MarketDataEvent } from '../types';

export interface MarketStateDeps {
  clock: Clock;
  eventSink: EventSink;
  sourceStatus: SourceStatusTracker;
  thresholds: FreshnessThresholds;
  /** `max_last_known_good_age_ms`，預設 300,000。 */
  max_last_known_good_age_ms: number;
  /** `freshness_check_interval_ms`，預設 500。 */
  freshness_check_interval_ms: number;
}

export type GetTickerResult = MarketDataEvent | 'NOT_TRACKED';

export class MarketState {
  private readonly latest = new Map<string, MarketDataEvent>();
  private readonly shortlisted = new Set<string>();
  /** instrument_id -> 目前是否處於 stale episode（避免重複發事件）。 */
  private readonly instrumentStaleEpisode = new Map<string, boolean>();
  /** exchange -> 該所最近一次「有資料更新」的本地接收時間。 */
  private readonly feedLastUpdate = new Map<ExchangeId, number>();
  private readonly feedStaleEpisode = new Map<ExchangeId, boolean>();
  private timer: TimerHandle | null = null;
  private stateVersion = 0;

  /** 遞增版本號，供呼叫端（例：研究端 live-scan）記憶化聚合結果。 */
  version(): number {
    return this.stateVersion;
  }

  constructor(private readonly deps: MarketStateDeps) {}

  // ---- 寫入 ----------------------------------------------------------

  /**
   * 只有較新的 `exchange_timestamp` 才覆寫；缺欄位的 null 由 adapter.parse 負責。
   *
   * 同一合約的欄位可能來自同所的多個 feed（例：OKX 把 tickers / funding-rate / mark-price
   * 拆成三個獨立 POLL；Bitget 的結算時程 POLL 與 tickers POLL 亦分開）。若整筆覆寫，較新但
   * 欄位較少的 feed 會把另一個 feed 剛寫入的欄位沖掉。因此這裡在「較新時覆寫」的前提下，對
   * 傳入事件中為 `null` 的欄位保留舊值（傳入的 `null` 不代表「現在是 null」，而是「這個 feed
   * 不提供這個欄位」——真正的「缺欄位」由各 adapter.parse 在單一 feed 內部就已經決定）。
   */
  upsert(event: MarketDataEvent): void {
    const existing = this.latest.get(event.symbol);
    if (existing && existing.exchange_timestamp >= event.exchange_timestamp) return;
    const merged: MarketDataEvent = existing
      ? {
          ...event,
          bid: event.bid ?? existing.bid,
          ask: event.ask ?? existing.ask,
          mark_price: event.mark_price ?? existing.mark_price,
          index_price: event.index_price ?? existing.index_price,
          funding_rate: event.funding_rate ?? existing.funding_rate,
          next_funding_time: event.next_funding_time ?? existing.next_funding_time,
          volume_24h_quote: event.volume_24h_quote ?? existing.volume_24h_quote,
        }
      : event;
    this.latest.set(event.symbol, merged);
    this.feedLastUpdate.set(event.exchange, this.deps.clock.now());
    this.stateVersion += 1;
  }

  remove(instrument_id: string): void {
    if (!this.latest.has(instrument_id)) return;
    this.latest.delete(instrument_id);
    this.instrumentStaleEpisode.delete(instrument_id);
    this.stateVersion += 1;
  }

  removeAllForExchange(exchange: ExchangeId): string[] {
    const removed: string[] = [];
    for (const [id, event] of this.latest) {
      if (event.exchange === exchange) {
        this.latest.delete(id);
        this.instrumentStaleEpisode.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  markShortlisted(instrument_id: string, inShortlist: boolean): void {
    if (inShortlist) this.shortlisted.add(instrument_id);
    else this.shortlisted.delete(instrument_id);
  }

  isShortlisted(instrument_id: string): boolean {
    return this.shortlisted.has(instrument_id);
  }

  // ---- 查詢 ----------------------------------------------------------

  getTicker(instrument_id: string): GetTickerResult {
    return this.latest.get(instrument_id) ?? 'NOT_TRACKED';
  }

  getFreshness(instrument_id: string): Freshness {
    const latest = this.latest.get(instrument_id);
    const tier = this.shortlisted.has(instrument_id) ? 'SHORTLIST' : 'FULL_MARKET';
    const exchange = latest?.exchange;
    const exchangeNowMs = exchange ? this.deps.clock.exchangeNow(exchange) : this.deps.clock.now();
    return computeFreshness({ latest, exchangeNowMs, tier, thresholds: this.deps.thresholds });
  }

  instrumentCount(exchange: ExchangeId): number {
    let count = 0;
    for (const event of this.latest.values()) if (event.exchange === exchange) count += 1;
    return count;
  }

  instrumentIdsForExchange(exchange: ExchangeId): string[] {
    const ids: string[] = [];
    for (const [id, event] of this.latest) if (event.exchange === exchange) ids.push(id);
    return ids;
  }

  // ---- 新鮮度排程 ------------------------------------------------------

  private emitStaleTransition(scope: 'INSTRUMENT' | 'FEED', exchange: ExchangeId, instrument_id: string | null, nowBecameStale: boolean, freshness: Freshness): void {
    this.deps.eventSink.emit({
      event_id: crypto.randomUUID(),
      event_type: nowBecameStale ? 'STALE_MARKET_DATA' : 'MARKET_DATA_RECOVERED',
      timestamp: this.deps.clock.now(),
      recorded_at: this.deps.clock.now(),
      exchange,
      symbol: instrument_id ?? undefined,
      trade_id: null,
      payload: { scope, data_age_ms: freshness.data_age_ms, threshold_ms: freshness.threshold_ms, tier: freshness.tier },
    });
  }

  /** 已入圍合約逐一評估（INSTRUMENT scope）；全市場層以 feed 最近更新時間評估（FEED scope）。 */
  checkFreshnessOnce(): void {
    for (const instrument_id of this.shortlisted) {
      const freshness = this.getFreshness(instrument_id);
      const wasStale = this.instrumentStaleEpisode.get(instrument_id) ?? false;
      if (freshness.stale !== wasStale) {
        const event = this.latest.get(instrument_id);
        this.instrumentStaleEpisode.set(instrument_id, freshness.stale);
        if (event) this.emitStaleTransition('INSTRUMENT', event.exchange, instrument_id, freshness.stale, freshness);
      }
    }

    for (const [exchange, lastUpdate] of this.feedLastUpdate) {
      const age = this.deps.clock.now() - lastUpdate;
      const threshold = this.deps.thresholds.full_market_threshold_ms;
      const isStale = age > threshold;
      const wasStale = this.feedStaleEpisode.get(exchange) ?? false;
      if (isStale !== wasStale) {
        this.feedStaleEpisode.set(exchange, isStale);
        this.emitStaleTransition('FEED', exchange, null, isStale, { data_age_ms: age, stale: isStale, tier: 'FULL_MARKET', threshold_ms: threshold });
      }
    }

    this.evictExpired();
  }

  private evictExpired(): void {
    for (const [exchange, lastUpdate] of this.feedLastUpdate) {
      const age = this.deps.clock.now() - lastUpdate;
      if (age > this.deps.max_last_known_good_age_ms) {
        this.removeAllForExchange(exchange);
        this.deps.sourceStatus.recordDataExpired(exchange);
      }
    }
  }

  /** 啟動定期新鮮度檢查（`freshness_check_interval_ms`，預設 500）。 */
  start(): void {
    const tick = (): void => {
      this.checkFreshnessOnce();
      this.timer = this.deps.clock.after(this.deps.freshness_check_interval_ms, tick);
    };
    this.timer = this.deps.clock.after(this.deps.freshness_check_interval_ms, tick);
  }

  stop(): void {
    if (this.timer) this.deps.clock.cancel(this.timer);
    this.timer = null;
  }
}
