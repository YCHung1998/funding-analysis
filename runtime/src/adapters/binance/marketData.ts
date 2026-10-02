/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Binance USD-M Futures 行情 adapter（design.md Decision 3，task 3.1）。
 * 全市場層：`!markPrice@arr` 推播 + 24h 量輪詢。入圍層：bookTicker + depth 組合串流。
 * 交易所差異只存在於此檔（Invariant #3）。
 */
import type { RestRequest } from '../../market/http/publicRestClient';
import type { MarketDataAdapter, MarketDataEvent, OrderBookSnapshot, ParsedMessage, PollFeedSpec, RateLimitRule, StreamFeedSpec } from '../../market/types';

const EXCHANGE = 'Binance' as const;
const REST_BASE = 'https://fapi.binance.com';
// 2026-10-01 實測（task 3.1 真實連線驗證）：`/ws/!markPrice@arr`（WHATWG 標準路徑）
// 連線後 35 s 內 0 則訊息；`/market/ws/!markPrice@arr` 連線後約 2 s 開始收到訊息，
// 15 s 內收到 10 則、每則 745 個 symbol，間隔與 design.md 記錄的 0.4–2.4 s 一致。
// Node 內建 WHATWG WebSocket 全程維持 OPEN（無需額外回應伺服器 ping frame 即可持續收訊），
// 不需要加入 `ws` 依賴（design.md Open Question 2 已回答，詳見本 change 最終報告）。
const WS_MARK_PRICE_URL = 'wss://fstream.binance.com/market/ws/!markPrice@arr';
const WS_COMBINED_URL = 'wss://fstream.binance.com/stream';

interface BinanceMarkPriceTick {
  e?: string;
  s: string;
  E: number;
  p: string;
  i?: string;
  r?: string;
  T?: number;
}

function parseMarkPriceTick(tick: BinanceMarkPriceTick, local_received: number): MarketDataEvent {
  return {
    exchange: EXCHANGE,
    symbol: `${EXCHANGE}:${tick.s}`,
    exchange_timestamp: tick.E,
    local_received_timestamp: local_received,
    timestamp_source: 'EXCHANGE',
    tier: 'FULL_MARKET',
    bid: null,
    ask: null,
    mark_price: tick.p !== undefined ? Number(tick.p) : null,
    index_price: tick.i !== undefined ? Number(tick.i) : null,
    funding_rate: tick.r !== undefined ? Number(tick.r) : null,
    next_funding_time: tick.T && tick.T > 0 ? tick.T : null,
  };
}

const markPriceStream: StreamFeedSpec = {
  kind: 'STREAM',
  name: 'markPriceArr',
  url: WS_MARK_PRICE_URL,
  heartbeat: { idle_timeout_ms: 90_000 }, // 伺服器送 ping frame、本模組不送應用層 ping（design.md Decision 6：pong 由傳輸層處理，未查證，見 task 3.1 report）
  parse(raw: string, local_received: number): ParsedMessage[] {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return [{ kind: 'IGNORED' }];
    }
    if (!Array.isArray(data)) return [{ kind: 'IGNORED' }];
    return (data as BinanceMarkPriceTick[])
      .filter((t) => typeof t.s === 'string')
      .map((t) => ({ kind: 'TICKER' as const, event: parseMarkPriceTick(t, local_received) }));
  },
};

interface Binance24hTicker {
  symbol: string;
  quoteVolume: string;
}

const volume24hPoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'ticker24hVolume',
  interval_ms: 60_000,
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/fapi/v1/ticker/24hr`, weight: 40 }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    if (!Array.isArray(body)) return [];
    return (body as Binance24hTicker[])
      .filter((t) => typeof t.symbol === 'string')
      .map((t) => ({
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${t.symbol}`,
        exchange_timestamp: local_received,
        local_received_timestamp: local_received,
        timestamp_source: 'RESPONSE',
        tier: 'FULL_MARKET',
        bid: null,
        ask: null,
        mark_price: null,
        index_price: null,
        funding_rate: null,
        volume_24h_quote: t.quoteVolume !== undefined ? Number(t.quoteVolume) : null,
      }));
  },
};

function shortlistTopics(native_symbol: string): string[] {
  const lower = native_symbol.toLowerCase();
  return [`${lower}@bookTicker`, `${lower}@depth20@100ms`];
}

interface BinanceCombinedEnvelope {
  stream?: string;
  data?: unknown;
  result?: unknown;
  id?: number;
}

// id 只需在連線內唯一（用來比對 ACK），不需要時間戳；以遞增計數器取代 Date.now()
// （架構守門：runtime/src 不得直接呼叫 Date.now，見 runtime/test/architecture.test.ts）。
let requestIdCounter = 0;
function nextRequestId(): number {
  requestIdCounter += 1;
  return requestIdCounter;
}

function buildSubscribe(topics: string[]): string {
  return JSON.stringify({ method: 'SUBSCRIBE', params: topics, id: nextRequestId() });
}

function buildUnsubscribe(topics: string[]): string {
  return JSON.stringify({ method: 'UNSUBSCRIBE', params: topics, id: nextRequestId() });
}

function parseShortlistMessage(raw: string, local_received: number): ParsedMessage[] {
  let env: BinanceCombinedEnvelope;
  try {
    env = JSON.parse(raw);
  } catch {
    return [{ kind: 'IGNORED' }];
  }
  if (env.result !== undefined && env.id !== undefined) return [{ kind: 'ACK', topics: [] }];
  const stream = env.stream;
  const data = env.data as Record<string, unknown> | undefined;
  if (!stream || !data) return [{ kind: 'IGNORED' }];

  if (stream.endsWith('@bookTicker')) {
    const symbol = String(data.s ?? '');
    const event: MarketDataEvent = {
      exchange: EXCHANGE,
      symbol: `${EXCHANGE}:${symbol}`,
      exchange_timestamp: Number(data.E ?? local_received),
      local_received_timestamp: local_received,
      timestamp_source: data.E !== undefined ? 'EXCHANGE' : 'LOCAL',
      tier: 'SHORTLIST',
      bid: data.b !== undefined ? Number(data.b) : null,
      ask: data.a !== undefined ? Number(data.a) : null,
      mark_price: null,
      index_price: null,
      funding_rate: null,
    };
    return [{ kind: 'TICKER', event }];
  }

  if (stream.includes('@depth')) {
    const symbol = String(data.s ?? stream.split('@')[0]).toUpperCase();
    const bids = Array.isArray(data.b) ? (data.b as [string, string][]).map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })) : [];
    const asks = Array.isArray(data.a) ? (data.a as [string, string][]).map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })) : [];
    const snapshot: OrderBookSnapshot = {
      exchange: EXCHANGE,
      symbol: `${EXCHANGE}:${symbol}`,
      exchange_timestamp: Number(data.E ?? local_received),
      local_received_timestamp: local_received,
      bids,
      asks,
    };
    // Binance depth20@100ms 為每則完整前 20 檔（SNAPSHOT_STREAM），非增量序號。
    return [{ kind: 'BOOK_SNAPSHOT', snapshot }];
  }

  return [{ kind: 'IGNORED' }];
}

const rateLimits: RateLimitRule[] = [
  {
    name: 'weight-1m',
    window_ms: 60_000,
    limit: 2400,
    unit: 'WEIGHT',
    usage_header: 'x-mbx-used-weight-1m',
    block_statuses: [429, 418],
    cooldown_ms: 60_000,
    verified: true, // BE-03 實測引述（design.md）
  },
];

export const binanceMarketDataAdapter: MarketDataAdapter = {
  exchange: EXCHANGE,
  fullMarket: [markPriceStream, volume24hPoll],
  shortlist: {
    topicsFor: shortlistTopics,
    book: { mode: 'SNAPSHOT_STREAM', depth: 20 },
  },
  ws: {
    url: WS_COMBINED_URL,
    heartbeat: { idle_timeout_ms: 90_000 }, // 伺服器 ping frame；客戶端回 pong 由傳輸層負責，未以 Node 內建 WebSocket 查證（task 3.1 report）
    buildSubscribe,
    buildUnsubscribe,
    parse: parseShortlistMessage,
  },
  rest: {
    envelopeError: (body: unknown) => {
      const b = body as { code?: number; msg?: string } | null;
      if (b && typeof b.code === 'number' && b.code < 0) return `Binance code ${b.code}: ${b.msg ?? ''}`;
      return null;
    },
    snapshotOrderBook: (native_symbol: string, depth: number): RestRequest => ({
      exchange: EXCHANGE,
      url: `${REST_BASE}/fapi/v1/depth?symbol=${native_symbol}&limit=${depth}`,
      weight: depth > 20 ? 10 : 5,
    }),
    parseOrderBookSnapshot: (body: unknown, native_symbol: string, local_received: number): OrderBookSnapshot => {
      const b = body as { lastUpdateId?: number; E?: number; bids: [string, string][]; asks: [string, string][] };
      return {
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${native_symbol}`,
        exchange_timestamp: b.E ?? local_received,
        local_received_timestamp: local_received,
        sequence: b.lastUpdateId,
        bids: b.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
        asks: b.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
      };
    },
  },
  rateLimits,
  serverTime: {
    request: (): RestRequest => ({ exchange: EXCHANGE, url: `${REST_BASE}/fapi/v1/time` }),
    parse: (body: unknown) => (body as { serverTime: number }).serverTime,
  },
};
