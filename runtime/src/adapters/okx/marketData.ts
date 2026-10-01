/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * OKX SWAP 行情 adapter（design.md Decision 3，task 3.3）。掃描用 `POLL`（tickers +
 * funding-rate + mark-price，每 30 s）。2026-10-01 實測：
 * `GET /api/v5/public/mark-price?instType=SWAP` 可用且批次回傳全市場（design.md
 * 標記「未查證」，本 change 已查證並改為直接取用，不再以 `last` 代替）。
 */
import type { RestRequest } from '../../market/http/publicRestClient';
import type { MarketDataEvent, PollFeedSpec, RateLimitRule } from '../../market/types';
import type { MarketDataAdapter, OrderBookSnapshot } from '../../market/types';

const EXCHANGE = 'OKX' as const;
const REST_BASE = 'https://www.okx.com';

interface OkxTicker {
  instId: string;
  last?: string;
  bidPx?: string;
  askPx?: string;
  volCcy24h?: string;
  ts?: string;
}

interface OkxFundingRate {
  instId: string;
  fundingRate?: string;
  fundingTime?: string;
  nextFundingTime?: string;
}

interface OkxMarkPrice {
  instId: string;
  markPx?: string;
  ts?: string;
}

const tickersPoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'tickers',
  interval_ms: 30_000,
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v5/market/tickers?instType=SWAP` }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    const list = (body as { data?: OkxTicker[] }).data ?? [];
    return list
      .filter((t) => typeof t.instId === 'string' && t.instId.endsWith('-USDT-SWAP'))
      .map((t) => ({
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${t.instId}`,
        exchange_timestamp: t.ts ? Number(t.ts) : local_received,
        local_received_timestamp: local_received,
        timestamp_source: t.ts ? 'EXCHANGE' : 'RESPONSE',
        tier: 'FULL_MARKET',
        bid: t.bidPx !== undefined ? Number(t.bidPx) : null,
        ask: t.askPx !== undefined ? Number(t.askPx) : null,
        mark_price: null, // 由 markPricePoll 合併（live-scan 聚合時取最新 exchange_timestamp 者）
        index_price: null,
        funding_rate: null,
        volume_24h_quote: t.volCcy24h !== undefined ? Number(t.volCcy24h) : null,
      }));
  },
};

const fundingRatePoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'fundingRate',
  interval_ms: 30_000,
  // instId=ANY：OKX 文件慣例，以此值取得全部 instId 的資金費（研究原型既有做法）。
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v5/public/funding-rate?instId=ANY`, weight: 1 }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    const list = (body as { data?: OkxFundingRate[] }).data ?? [];
    return list
      .filter((f) => typeof f.instId === 'string')
      .map((f) => {
        const nextFundingTime = Number(f.fundingTime ?? f.nextFundingTime ?? 0);
        return {
          exchange: EXCHANGE,
          symbol: `${EXCHANGE}:${f.instId}`,
          exchange_timestamp: local_received,
          local_received_timestamp: local_received,
          timestamp_source: 'RESPONSE' as const,
          tier: 'FULL_MARKET' as const,
          bid: null,
          ask: null,
          mark_price: null,
          index_price: null,
          funding_rate: f.fundingRate !== undefined ? Number(f.fundingRate) : null,
          next_funding_time: nextFundingTime > 0 ? nextFundingTime : null,
        };
      });
  },
};

const markPricePoll: PollFeedSpec = {
  kind: 'POLL',
  name: 'markPrice',
  interval_ms: 30_000,
  request: () => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v5/public/mark-price?instType=SWAP` }),
  parse(body: unknown, local_received: number): MarketDataEvent[] {
    const list = (body as { data?: OkxMarkPrice[] }).data ?? [];
    return list
      .filter((m) => typeof m.instId === 'string')
      .map((m) => ({
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${m.instId}`,
        exchange_timestamp: m.ts ? Number(m.ts) : local_received,
        local_received_timestamp: local_received,
        timestamp_source: m.ts ? 'EXCHANGE' : 'RESPONSE',
        tier: 'FULL_MARKET',
        bid: null,
        ask: null,
        mark_price: m.markPx !== undefined ? Number(m.markPx) : null,
        index_price: null,
        funding_rate: null,
      }));
  },
};

const rateLimits: RateLimitRule[] = [
  {
    name: 'tickers-2s',
    window_ms: 2_000,
    limit: 20,
    unit: 'REQUESTS',
    block_statuses: [429],
    cooldown_ms: 60_000,
    verified: true,
  },
  {
    name: 'funding-rate-2s',
    window_ms: 2_000,
    limit: 10,
    unit: 'REQUESTS',
    block_statuses: [429],
    cooldown_ms: 60_000,
    verified: true,
  },
];

export const okxMarketDataAdapter: MarketDataAdapter = {
  exchange: EXCHANGE,
  fullMarket: [tickersPoll, fundingRatePoll, markPricePoll],
  // trading_exchanges 目前不含 OKX（design.md Decision 2）；shortlist 留待未來加入。
  rest: {
    envelopeError: (body: unknown) => {
      const b = body as { code?: string; msg?: string } | null;
      if (b && typeof b.code === 'string' && b.code !== '0') return `OKX code ${b.code}: ${b.msg ?? ''}`;
      return null;
    },
    snapshotOrderBook: (native_symbol: string, depth: number): RestRequest => ({
      exchange: EXCHANGE,
      url: `${REST_BASE}/api/v5/market/books?instId=${native_symbol}&sz=${depth}`,
    }),
    parseOrderBookSnapshot: (body: unknown, native_symbol: string, local_received: number): OrderBookSnapshot => {
      const b = body as { data: [{ asks: [string, string, string, string][]; bids: [string, string, string, string][]; ts: string }] };
      const entry = b.data[0];
      return {
        exchange: EXCHANGE,
        symbol: `${EXCHANGE}:${native_symbol}`,
        exchange_timestamp: Number(entry.ts),
        local_received_timestamp: local_received,
        bids: entry.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
        asks: entry.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
      };
    },
  },
  rateLimits,
  serverTime: {
    request: (): RestRequest => ({ exchange: EXCHANGE, url: `${REST_BASE}/api/v5/public/time` }),
    parse: (body: unknown) => Number((body as { data: [{ ts: string }] }).data[0].ts),
  },
};
