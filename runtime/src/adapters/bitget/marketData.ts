/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bitget USDT-FUTURES 行情 adapter（design.md Decision 3，task 3.3）。掃描用 `POLL`
 * 每 30 s：tickers（markPrice / fundingRate / usdtVolume）+ current-fund-rate（結算時程）。
 * 限流數值未查證（design.md Risks），採保守值並於下方標註。
 */
import type { RestRequest } from '../../market/http/publicRestClient';
import type { MarketDataAdapter, MarketDataEvent, OrderBookSnapshot, PollFeedSpec, RateLimitRule } from '../../market/types';

const EXCHANGE = 'Bitget' as const;
const REST_BASE = 'https://api.bitget.com';

interface BitgetTicker {
  symbol: string;
  markPrice?: string;
  bidPr?: string;
  askPr?: string;
  fundingRate?: string;
  usdtVolume?: string;
  ts?: string;
}

interface BitgetFundRate {
  symbol: string;
  nextUpdate?: string;
  fundingRateInterval?: string;
}

const tickersPoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'tickers',
  interval_ms: 30_000,
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v2/mix/market/tickers?productType=USDT-FUTURES` }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    const list = (body as { data?: BitgetTicker[] }).data ?? [];
    return list
      .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
      .map((t) => ({
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${t.symbol}`,
        exchange_timestamp: t.ts ? Number(t.ts) : local_received,
        local_received_timestamp: local_received,
        timestamp_source: t.ts ? 'EXCHANGE' : 'RESPONSE',
        tier: 'FULL_MARKET',
        bid: t.bidPr !== undefined ? Number(t.bidPr) : null,
        ask: t.askPr !== undefined ? Number(t.askPr) : null,
        mark_price: t.markPrice !== undefined ? Number(t.markPrice) : null,
        index_price: null,
        funding_rate: t.fundingRate !== undefined ? Number(t.fundingRate) : null,
        volume_24h_quote: t.usdtVolume !== undefined ? Number(t.usdtVolume) : null,
      }));
  },
};

const fundingSchedulePoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'currentFundRate',
  interval_ms: 300_000, // design.md Decision 5：5 分鐘節奏（與既有 server.ts 做法一致）
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES` }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    const list = (body as { data?: BitgetFundRate[] }).data ?? [];
    return list
      .filter((f) => typeof f.symbol === 'string' && f.nextUpdate)
      .map((f) => ({
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${f.symbol}`,
        exchange_timestamp: local_received,
        local_received_timestamp: local_received,
        timestamp_source: 'RESPONSE',
        tier: 'FULL_MARKET',
        bid: null,
        ask: null,
        mark_price: null,
        index_price: null,
        funding_rate: null,
        next_funding_time: Number(f.nextUpdate),
      }));
  },
};

// Bitget 限流規則：官方數值未查證（design.md Risks「Bitget 限流數值：未查證」）。
// 保守值：每秒 10 次（研究原型既有假設），HTTP 429 觸發斷路器；偵測到 429 時自動退避。
const rateLimits: RateLimitRule[] = [
  {
    name: 'conservative-per-second',
    window_ms: 1_000,
    limit: 10,
    unit: 'REQUESTS',
    block_statuses: [429],
    cooldown_ms: 60_000,
    verified: false,
  },
];

export const bitgetMarketDataAdapter: MarketDataAdapter = {
  exchange: EXCHANGE,
  fullMarket: [tickersPoll, fundingSchedulePoll],
  rest: {
    envelopeError: (body: unknown) => {
      const b = body as { code?: string; msg?: string } | null;
      if (b && typeof b.code === 'string' && b.code !== '00000') return `Bitget code ${b.code}: ${b.msg ?? ''}`;
      return null;
    },
    snapshotOrderBook: (native_symbol: string, depth: number): RestRequest => ({
      exchange: EXCHANGE,
      url: `${REST_BASE}/api/v2/mix/market/merge-depth?symbol=${native_symbol}&productType=USDT-FUTURES&limit=${depth}`,
    }),
    parseOrderBookSnapshot: (body: unknown, native_symbol: string, local_received: number): OrderBookSnapshot => {
      const b = body as { data: { asks: [string, string][]; bids: [string, string][]; ts: string } };
      return {
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${native_symbol}`,
        exchange_timestamp: Number(b.data.ts),
        local_received_timestamp: local_received,
        bids: b.data.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
        asks: b.data.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
      };
    },
  },
  rateLimits,
  serverTime: {
    request: (): RestRequest => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v2/public/time` }),
    parse: (body: unknown) => Number((body as { data: { serverTime: string } }).data.serverTime),
  },
};
