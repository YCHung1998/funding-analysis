/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bybit linear perpetual 行情 adapter（design.md Decision 3，task 3.2）。
 * 全市場層：批次 tickers `POLL` 每 10 s。入圍層：`tickers.{symbol}` + `orderbook.50.{symbol}`
 * （`DELTA_STREAM`），每 20 s 應用層 ping。欄位名稱以 2026-10-01 實測核對（`fundingIntervalHour` 存在）。
 */
import type { RestRequest } from '../../market/http/publicRestClient';
import type { MarketDataAdapter, MarketDataEvent, MarketTimestampSource, OrderBookSnapshot, ParsedMessage, PollFeedSpec, RateLimitRule } from '../../market/types';

const EXCHANGE = 'Bybit' as const;
const REST_BASE = 'https://api.bybit.com';
const WS_URL = 'wss://stream.bybit.com/v5/public/linear';

interface BybitTicker {
  symbol: string;
  bid1Price?: string;
  ask1Price?: string;
  markPrice?: string;
  indexPrice?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  fundingIntervalHour?: string;
  turnover24h?: string;
}

function parseTicker(t: BybitTicker, tier: 'FULL_MARKET' | 'SHORTLIST', exchange_timestamp: number, local_received: number, timestamp_source: MarketTimestampSource): MarketDataEvent {
  const nextFundingTime = t.nextFundingTime ? Number(t.nextFundingTime) : 0;
  return {
    exchange: EXCHANGE,
    symbol: `${EXCHANGE}:${t.symbol}`,
    exchange_timestamp,
    local_received_timestamp: local_received,
    timestamp_source,
    tier,
    bid: t.bid1Price !== undefined ? Number(t.bid1Price) : null,
    ask: t.ask1Price !== undefined ? Number(t.ask1Price) : null,
    mark_price: t.markPrice !== undefined ? Number(t.markPrice) : null,
    index_price: t.indexPrice !== undefined ? Number(t.indexPrice) : null,
    funding_rate: t.fundingRate !== undefined ? Number(t.fundingRate) : null,
    next_funding_time: nextFundingTime > 0 ? nextFundingTime : null,
    volume_24h_quote: t.turnover24h !== undefined ? Number(t.turnover24h) : null,
  };
}

const tickersPoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'tickers',
  interval_ms: 10_000,
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/v5/market/tickers?category=linear` }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    const b = body as { time?: number; result?: { list?: BybitTicker[] } };
    const list = b.result?.list ?? [];
    const exchange_timestamp = b.time ?? local_received;
    return list.filter((t) => typeof t.symbol === 'string').map((t) => parseTicker(t, 'FULL_MARKET', exchange_timestamp, local_received, 'RESPONSE'));
  },
};

function shortlistTopics(native_symbol: string): string[] {
  return [`tickers.${native_symbol}`, `orderbook.50.${native_symbol}`];
}

function buildSubscribe(topics: string[]): string {
  return JSON.stringify({ op: 'subscribe', args: topics });
}

function buildUnsubscribe(topics: string[]): string {
  return JSON.stringify({ op: 'unsubscribe', args: topics });
}

interface BybitWsEnvelope {
  topic?: string;
  type?: string; // 'snapshot' | 'delta'
  ts?: number;
  data?: unknown;
  op?: string;
  success?: boolean;
  args?: string[];
  ret_msg?: string;
}

function parseWsMessage(raw: string, local_received: number): ParsedMessage[] {
  let env: BybitWsEnvelope;
  try {
    env = JSON.parse(raw);
  } catch {
    return [{ kind: 'IGNORED' }];
  }

  if (env.op === 'pong' || env.ret_msg === 'pong') return [{ kind: 'PONG' }];
  if (env.op === 'subscribe') return env.success ? [{ kind: 'ACK', topics: env.args ?? [] }] : [{ kind: 'IGNORED' }];

  if (!env.topic || !env.data) return [{ kind: 'IGNORED' }];

  if (env.topic.startsWith('tickers.')) {
    const symbol = env.topic.slice('tickers.'.length);
    const t = env.data as BybitTicker;
    const event = parseTicker({ ...t, symbol }, 'SHORTLIST', env.ts ?? local_received, local_received, env.ts !== undefined ? 'EXCHANGE' : 'LOCAL');
    return [{ kind: 'TICKER', event }];
  }

  if (env.topic.startsWith('orderbook.')) {
    const parts = env.topic.split('.');
    const symbol = parts[parts.length - 1];
    const d = env.data as { s?: string; b: [string, string][]; a: [string, string][]; u: number; seq?: number };
    const bids = d.b.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) }));
    const asks = d.a.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) }));
    const exchange_timestamp = env.ts ?? local_received;
    if (env.type === 'snapshot') {
      const snapshot: OrderBookSnapshot = {
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${symbol}`,
        exchange_timestamp,
        local_received_timestamp: local_received,
        sequence: d.u,
        bids,
        asks,
      };
      return [{ kind: 'BOOK_SNAPSHOT', snapshot }];
    }
    return [
      {
        kind: 'BOOK_DELTA',
        delta: {
          exchange: EXCHANGE,
          symbol: `${EXCHANGE}:${symbol}`,
          exchange_timestamp,
          local_received_timestamp: local_received,
          sequence: d.u,
          prev_sequence: d.u - 1, // Bybit v5：u 單調遞增，缺口偵測以 prev_sequence !== 目前序號判定（未逐檔驗證，task 3.2 待定）
          bids,
          asks,
        },
      },
    ];
  }

  return [{ kind: 'IGNORED' }];
}

const rateLimits: RateLimitRule[] = [
  {
    name: 'per-ip-5s',
    window_ms: 5_000,
    limit: 600,
    unit: 'REQUESTS',
    block_statuses: [403],
    cooldown_ms: 600_000, // 403 → 至少 10 分鐘（spec 明文）
    verified: true,
  },
];

export const bybitMarketDataAdapter: MarketDataAdapter = {
  exchange: EXCHANGE,
  fullMarket: [tickersPoll],
  shortlist: {
    topicsFor: shortlistTopics,
    book: { mode: 'DELTA_STREAM', depth: 50 },
  },
  ws: {
    url: WS_URL,
    heartbeat: { client_ping_interval_ms: 20_000, ping_payload: JSON.stringify({ op: 'ping' }), idle_timeout_ms: 30_000 },
    buildSubscribe,
    buildUnsubscribe,
    parse: parseWsMessage,
  },
  rest: {
    envelopeError: (body: unknown) => {
      const b = body as { retCode?: number; retMsg?: string } | null;
      if (b && typeof b.retCode === 'number' && b.retCode !== 0) return `Bybit retCode ${b.retCode}: ${b.retMsg ?? ''}`;
      return null;
    },
    snapshotOrderBook: (native_symbol: string, depth: number): RestRequest => ({
      exchange: EXCHANGE,
      url: `${REST_BASE}/v5/market/orderbook?category=linear&symbol=${native_symbol}&limit=${depth}`,
    }),
    parseOrderBookSnapshot: (body: unknown, native_symbol: string, local_received: number): OrderBookSnapshot => {
      const b = body as { time?: number; result: { ts?: number; u?: number; b: [string, string][]; a: [string, string][] } };
      return {
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${native_symbol}`,
        exchange_timestamp: b.result.ts ?? b.time ?? local_received,
        local_received_timestamp: local_received,
        sequence: b.result.u,
        bids: b.result.b.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
        asks: b.result.a.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
      };
    },
  },
  rateLimits,
  serverTime: {
    request: (): RestRequest => ({ exchange: EXCHANGE, url: `${REST_BASE}/v5/market/time` }),
    parse: (body: unknown) => (body as { time: number }).time,
  },
};
