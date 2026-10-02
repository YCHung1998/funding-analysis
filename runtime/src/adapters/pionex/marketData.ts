/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pionex PERP 行情 adapter（design.md Decision 3，task 3.3）。掃描用 `POLL` 每 30 s：
 * indexes（markPrice / nextFundingRate / nextFundingTime）+ tickers（24h 成交額 `amount`）。
 * 無伺服器時間端點，以輕量帶 symbol 的行情請求（depth, limit=1）取得回應層級 `timestamp`
 * （spec「Exchange server time query」明文）。
 */
import type { RestRequest } from '../../market/http/publicRestClient';
import type { MarketDataAdapter, MarketDataEvent, OrderBookSnapshot, PollFeedSpec, RateLimitRule } from '../../market/types';

const EXCHANGE = 'Pionex' as const;
const REST_BASE = 'https://api.pionex.com';
/** 伺服器時間查詢用的輕量 symbol（design.md 跨 change 假設；本 change 不保證此合約存在，見 task 3.3 report）。 */
const SERVER_TIME_PROBE_SYMBOL = 'BTC_USDT_PERP';

interface PionexIndex {
  symbol: string;
  indexPrice?: string;
  markPrice?: string;
  nextFundingRate?: string;
  nextFundingTime?: number;
  updateTime?: number;
}

interface PionexTicker {
  symbol: string;
  amount?: string;
  time?: number;
}

const indexesPoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'indexes',
  interval_ms: 30_000,
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v1/market/indexes` }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    const b = body as { data?: { indexes?: PionexIndex[] }; timestamp?: number };
    const list = b.data?.indexes ?? [];
    const exchange_timestamp = b.timestamp ?? local_received;
    return list
      .filter((item) => typeof item.symbol === 'string' && item.symbol.endsWith('_PERP'))
      .map((item) => ({
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${item.symbol}`,
        exchange_timestamp: item.updateTime ?? exchange_timestamp,
        local_received_timestamp: local_received,
        timestamp_source: item.updateTime ? 'EXCHANGE' : 'RESPONSE',
        tier: 'FULL_MARKET',
        bid: null,
        ask: null,
        mark_price: item.markPrice !== undefined ? Number(item.markPrice) : null,
        index_price: item.indexPrice !== undefined ? Number(item.indexPrice) : null,
        funding_rate: item.nextFundingRate !== undefined ? Number(item.nextFundingRate) : null,
        next_funding_time: item.nextFundingTime && item.nextFundingTime > 0 ? item.nextFundingTime : null,
      }));
  },
};

const tickersPoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'tickersVolume',
  interval_ms: 30_000,
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v1/market/tickers?type=PERP` }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    const list = (body as { data?: { tickers?: PionexTicker[] } }).data?.tickers ?? [];
    return list
      .filter((t) => typeof t.symbol === 'string' && t.amount !== undefined)
      .map((t) => ({
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${t.symbol}`,
        exchange_timestamp: t.time ?? local_received,
        local_received_timestamp: local_received,
        timestamp_source: t.time ? 'EXCHANGE' : 'RESPONSE',
        tier: 'FULL_MARKET',
        bid: null,
        ask: null,
        mark_price: null,
        index_price: null,
        funding_rate: null,
        volume_24h_quote: t.amount !== undefined ? Number(t.amount) : null,
      }));
  },
};

// 2026-09-30 實測（design.md）：所有端點共用每秒 10 次，429 封鎖 60 s。
const rateLimits: RateLimitRule[] = [
  {
    name: 'shared-per-second',
    window_ms: 1_000,
    limit: 10,
    unit: 'REQUESTS',
    block_statuses: [429],
    cooldown_ms: 60_000,
    verified: true,
  },
];

export const pionexMarketDataAdapter: MarketDataAdapter = {
  exchange: EXCHANGE,
  fullMarket: [indexesPoll, tickersPoll],
  rest: {
    envelopeError: (body: unknown) => {
      const b = body as { result?: boolean; message?: string } | null;
      if (b && b.result === false) return `Pionex error: ${b.message ?? 'unknown'}`;
      return null;
    },
    snapshotOrderBook: (native_symbol: string, depth: number): RestRequest => ({
      exchange: EXCHANGE,
      url: `${REST_BASE}/api/v1/market/depth?symbol=${native_symbol}&limit=${depth}`,
    }),
    parseOrderBookSnapshot: (body: unknown, native_symbol: string, local_received: number): OrderBookSnapshot => {
      const b = body as { data: { bids: [string, string][]; asks: [string, string][]; updateTime?: number }; timestamp?: number };
      return {
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${native_symbol}`,
        exchange_timestamp: b.data.updateTime ?? b.timestamp ?? local_received,
        local_received_timestamp: local_received,
        bids: b.data.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
        asks: b.data.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
      };
    },
  },
  rateLimits,
  serverTime: {
    request: (): RestRequest => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v1/market/depth?symbol=${SERVER_TIME_PROBE_SYMBOL}&limit=1` }),
    parse: (body: unknown) => Number((body as { timestamp: number }).timestamp),
  },
};
