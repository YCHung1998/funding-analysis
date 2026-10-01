/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * websocket-data-layer 核心型別（design.md Decision 1/2/9、spec market-data-stream /
 * market-data-snapshot）。不得以交易所名稱做條件分支（Invariant #3，由
 * runtime/test/architecture.test.ts 與本模組 noExchangeLiteral 檢查把關）。
 *
 * `ExchangeId`、`TradingEvent` 由 `runtime/src/types/`（trading-schema-types）提供。
 */

import type { ExchangeId } from '../types/ids';
import type { RestRequest } from './http/publicRestClient';

export type { ExchangeId };

/** 行情層級：全市場（WATCH / 研究掃描）或入圍（SHORTLIST → CONFIRM）。 */
export type MarketDataTier = 'FULL_MARKET' | 'SHORTLIST';

/**
 * 時間戳來源（market-data-stream spec「Normalized market data with dual
 * timestamps」）。注意：與 `runtime/src/types/ids.ts` 的實體層 `TimestampSource`
 * 語意不同（那裡沒有 `'RESPONSE'`），本模組專用，不重複定義在 types/ 內
 * （目錄所有權：runtime/README.md）。
 */
export type MarketTimestampSource = 'EXCHANGE' | 'RESPONSE' | 'LOCAL';

/** 技術書 §8 的正規化行情事件（spec「Normalized market data with dual timestamps」）。 */
export interface MarketDataEvent {
  exchange: ExchangeId;
  /** = instrument_id（`${exchange}:${native_symbol}`）。 */
  symbol: string;
  exchange_timestamp: number;
  local_received_timestamp: number;
  timestamp_source: MarketTimestampSource;
  tier: MarketDataTier;
  sequence?: number;
  bid: number | null;
  ask: number | null;
  mark_price: number | null;
  index_price: number | null;
  funding_rate: number | null;
  next_funding_time?: number | null;
  volume_24h_quote?: number | null;
}

// ---------------------------------------------------------------------------
// Adapter feed 描述（design.md Decision 2）
// ---------------------------------------------------------------------------

export interface PollFeedSpec {
  kind: 'POLL';
  /** 人類可讀名稱，記錄 / 除錯用（非交易所名稱字面值分支）。 */
  name: string;
  interval_ms: number;
  request(): RestRequest;
  /** 解析回應為零或多筆正規化事件；local_received 由呼叫端（已經過 Clock）傳入。 */
  parse(body: unknown, local_received: number): MarketDataEvent[];
}

export interface StreamFeedSpec {
  kind: 'STREAM';
  name: string;
  url: string;
  heartbeat: {
    client_ping_interval_ms?: number;
    ping_payload?: string;
    idle_timeout_ms: number;
  };
  max_topics_per_connection?: number;
  max_connection_lifetime_ms?: number;
  /** 全市場 STREAM 通常不需訂閱特定主題（例如 Binance `!markPrice@arr`）。 */
  topics?: string[];
  buildSubscribe?(topics: string[]): string;
  buildUnsubscribe?(topics: string[]): string;
  parse(raw: string, local_received: number): ParsedMessage[];
}

export type ParsedMessage =
  | { kind: 'TICKER'; event: MarketDataEvent }
  | { kind: 'BOOK_SNAPSHOT'; snapshot: OrderBookSnapshot }
  | { kind: 'BOOK_DELTA'; delta: OrderBookDelta }
  | { kind: 'ACK'; topics: string[] }
  | { kind: 'PONG' }
  | { kind: 'IGNORED' };

export interface OrderBookLevel {
  price: number;
  qty: number;
}

export interface OrderBookSnapshot {
  exchange: ExchangeId;
  symbol: string;
  exchange_timestamp: number;
  local_received_timestamp: number;
  sequence?: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface OrderBookDelta {
  exchange: ExchangeId;
  symbol: string;
  exchange_timestamp: number;
  local_received_timestamp: number;
  sequence: number;
  prev_sequence: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface ShortlistSpec {
  topicsFor(native_symbol: string): string[];
  book: { mode: 'SNAPSHOT_STREAM' | 'DELTA_STREAM'; depth: number };
}

export interface RateLimitRule {
  /** 規則名稱，記錄 / 除錯用。 */
  name: string;
  window_ms: number;
  limit: number;
  unit: 'REQUESTS' | 'WEIGHT';
  /** 符合此規則的請求權重（預設 1）。 */
  weight?: number;
  /** 回應標頭帶用量時的標頭名稱（例：Binance `X-MBX-USED-WEIGHT-1M`）。 */
  usage_header?: string;
  /** 觸發斷路器的 HTTP 狀態碼集合。 */
  block_statuses: number[];
  cooldown_ms: number;
  /** 本規則表是否已以實測或官方文件查證（design.md Risks：Bitget 未查證）。 */
  verified: boolean;
}

export interface MarketDataAdapter {
  exchange: ExchangeId;
  fullMarket: Array<StreamFeedSpec | PollFeedSpec>;
  shortlist?: ShortlistSpec;
  ws?: {
    url: string;
    heartbeat: { client_ping_interval_ms?: number; ping_payload?: string; idle_timeout_ms: number };
    max_topics_per_connection?: number;
    max_connection_lifetime_ms?: number;
    buildSubscribe(topics: string[]): string;
    buildUnsubscribe(topics: string[]): string;
    parse(raw: string, local_received: number): ParsedMessage[];
  };
  rest: {
    /** 回傳信封錯誤訊息（null = 無錯誤）；OKX `code`、Bybit `retCode`、Bitget `code`。 */
    envelopeError(body: unknown): string | null;
    snapshotOrderBook(native_symbol: string, depth: number): RestRequest;
    parseOrderBookSnapshot(body: unknown, native_symbol: string, local_received: number): OrderBookSnapshot;
  };
  rateLimits: RateLimitRule[];
  serverTime: {
    request(): RestRequest;
    parse(body: unknown): number;
  };
}

// ---------------------------------------------------------------------------
// SourceStatus（market-data-snapshot spec「Per-exchange source status」）
// ---------------------------------------------------------------------------

export type SourceStatusState = 'INITIALIZING' | 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'RATE_LIMITED';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SourceStatus {
  exchange: ExchangeId;
  state: SourceStatusState;
  last_success_at: number | null;
  last_error: { kind: string; http_status?: number; at: number } | null;
  consecutive_failures: number;
  data_age_ms: number | null;
  instrument_count: number;
  rate_limit: {
    used: number;
    limit: number;
    window_ms: number;
    circuit: CircuitState;
  } | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Freshness（market-data-stream spec「Data freshness」）
// ---------------------------------------------------------------------------

export interface Freshness {
  data_age_ms: number | null;
  stale: boolean;
  tier: MarketDataTier;
  threshold_ms: number;
}

// ---------------------------------------------------------------------------
// ServerTime（market-data-snapshot spec「Exchange server time query」）
// ---------------------------------------------------------------------------

export interface ServerTimeSample {
  exchange: ExchangeId;
  server_time: number;
  local_sent: number;
  local_received: number;
}

// ---------------------------------------------------------------------------
// WebSocket 傳輸注入點（design.md Decision 6）
// ---------------------------------------------------------------------------

export interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

// ---------------------------------------------------------------------------
// promote / release 結果（market-data-stream spec「Shortlist tier promotion」）
// ---------------------------------------------------------------------------

export type PromoteItemResult =
  | { instrument_id: string; status: 'OK' }
  | { instrument_id: string; status: 'REJECTED_NOT_TRADING_EXCHANGE' | 'REJECTED_NOT_SUBSCRIBABLE' };

export interface PromoteResult {
  results: PromoteItemResult[];
}
