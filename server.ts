/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Full-Stack Arbitrage Engine Server (Pionex × Binance × Bybit × Bitget × OKX)
 */

import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import {
  buildHealthApiPayload,
  buildReconciliationLatestPayload,
  readLatestReconciliationRun,
  readRuntimeHealthRow,
} from './runtime/src/health/healthPublisher';
import { buildLiveScanCandidates } from './server/liveScanRegistry';
import {
  getAccountSnapshot,
  getCompletedTrades,
  getCurrentTrades,
  getTradeDetail,
  getTradeEvents,
  MalformedCursorError,
  openPaperDb as openPaperReadDb,
  PaperReadLayerUnavailableError,
} from './server/paperReadLayer';
import { resolveKlinesSymbol } from './server/liveKlinesResolve';
import { InstrumentRegistry } from './runtime/src/market/instruments/registry';
import { UpstreamError } from './runtime/src/market/http/publicRestClient';
import { GuardedRestClient } from './runtime/src/market/http/guardedRestClient';
import { SourceStatusTracker } from './runtime/src/market/sourceStatus';
import { MarketState } from './runtime/src/market/state/marketState';
import { OrderBookService } from './runtime/src/market/orderBookService';
import { MarketDataService } from './runtime/src/market/marketDataService';
import { queryServerTime } from './runtime/src/market/serverTime';
import { RealClock } from './runtime/src/clock/realClock';
import { normalizeBinanceInstruments } from './runtime/src/adapters/binance/instruments';
import { normalizeBybitInstruments } from './runtime/src/adapters/bybit/instruments';
import { normalizeOkxInstruments } from './runtime/src/adapters/okx/instruments';
import { normalizeBitgetInstruments } from './runtime/src/adapters/bitget/instruments';
import { normalizePionexInstruments } from './runtime/src/adapters/pionex/instruments';
import { binanceMarketDataAdapter } from './runtime/src/adapters/binance/marketData';
import { bybitMarketDataAdapter } from './runtime/src/adapters/bybit/marketData';
import { okxMarketDataAdapter } from './runtime/src/adapters/okx/marketData';
import { bitgetMarketDataAdapter } from './runtime/src/adapters/bitget/marketData';
import { pionexMarketDataAdapter } from './runtime/src/adapters/pionex/marketData';
import { buildLegDataFromMarketState, buildSourcesSnapshot, buildDataAsOf } from './server/liveScanFromMarketState';
import type { ExchangeId, EventSink, TradingEvent, InstrumentSourceStatus } from './runtime/src/market/instruments/types';
import type { RateLimitRule, MarketDataAdapter } from './runtime/src/market/types';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

export type ExchangeName = 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';

// --- Instrument Registry wiring (openspec/changes/instrument-registry) ---
// server.ts 不在 runtime/src/ 內，可直接讀系統時間 / 使用計時器（design.md Decision 9）。

const RECENT_EVENTS_LIMIT = 200;
const recentEvents: TradingEvent[] = [];
const consoleEventSink: EventSink = {
  emit(event) {
    recentEvents.push(event);
    if (recentEvents.length > RECENT_EVENTS_LIMIT) recentEvents.shift();
    console.log(`[registry-event] ${JSON.stringify(event)}`);
  },
};

const registry = new InstrumentRegistry(consoleEventSink);

// --- websocket-data-layer wiring（task 4.2：嵌入式行情服務） ---------------

const clock = new RealClock();
const sourceStatus = new SourceStatusTracker({ eventSink: consoleEventSink, now: () => clock.now() });

const marketDataAdapters: Partial<Record<ExchangeId, MarketDataAdapter>> = {
  Binance: binanceMarketDataAdapter,
  Bybit: bybitMarketDataAdapter,
  OKX: okxMarketDataAdapter,
  Bitget: bitgetMarketDataAdapter,
  Pionex: pionexMarketDataAdapter,
};

const rateLimitRulesByExchange = Object.fromEntries(
  Object.entries(marketDataAdapters).map(([ex, adapter]) => [ex, adapter!.rateLimits]),
) as Record<ExchangeId, RateLimitRule[]>;

const restClient = new GuardedRestClient({
  clock,
  eventSink: consoleEventSink,
  rateLimitRules: rateLimitRulesByExchange,
  sourceStatus,
  envelopeError: (exchange, body) => marketDataAdapters[exchange]?.rest.envelopeError(body) ?? null,
});

const marketState = new MarketState({
  clock,
  eventSink: consoleEventSink,
  sourceStatus,
  // watch_stale_threshold_ms 設計上應為「該所 feed 輪詢間隔 × 3」（design.md Decision 5 第 5 點），
  // 目前 MarketState 只接受單一全域門檻（待定：改為逐所門檻，見本 change 最終報告「待定」清單）；
  // 暫以最慢的全市場 POLL 間隔（Pionex / Bitget / OKX 30 s）× 3 = 90 s 作為保守值，
  // 避免輪詢間隔本身就逼近門檻而產生假性 stale/recovered 抖動（task 5.1 實測發現）。
  thresholds: { shortlist_threshold_ms: 3000, full_market_threshold_ms: 90_000 },
  max_last_known_good_age_ms: 300_000,
  freshness_check_interval_ms: 500,
});
marketState.start();

const orderBookService = new OrderBookService({
  clock,
  eventSink: consoleEventSink,
  restClient,
  adapterFor: (exchange) => marketDataAdapters[exchange as ExchangeId]!,
});

const SCAN_EXCHANGES: ExchangeId[] = ['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'];
// trading_exchanges：目前只有 Binance、Bybit 的 adapter 宣告 shortlist（design.md Decision 2）。
// server.ts 本身沒有場次（proposal「研究端過渡」），promote/release 只供未來 Paper Runtime 使用。
const TRADING_EXCHANGES: ExchangeId[] = ['Binance', 'Bybit'];

const marketDataService = new MarketDataService({
  clock,
  eventSink: consoleEventSink,
  registry,
  restClient,
  marketState,
  orderBook: orderBookService,
  sourceStatus,
  wsFactory: (url: string) => new WebSocket(url) as unknown as import('./runtime/src/market/types').MinimalWebSocket,
  adapters: marketDataAdapters,
  scan_exchanges: SCAN_EXCHANGES,
  trading_exchanges: TRADING_EXCHANGES,
  reconnect_backoff: { base_ms: 1000, max_ms: 60_000, jitter_ratio: 0.2 },
  backoff_reset_after_ms: 60_000,
});

const SERVER_TIME_CALIBRATION_INTERVAL_MS = 30_000;

async function calibrateClock(): Promise<void> {
  await Promise.all(
    SCAN_EXCHANGES.map(async (exchange) => {
      const adapter = marketDataAdapters[exchange];
      if (!adapter) return;
      try {
        const sentAt = clock.now();
        const sample = await queryServerTime(restClient, adapter);
        const receivedAt = clock.now();
        clock.calibrate(exchange, { sentAt, serverTime: sample.server_time, receivedAt });
      } catch (err) {
        console.error(`[market-data] clock calibration failed for ${exchange}:`, err);
      }
    }),
  );
}

let registrySuccessfulSourceCount = 0;
let registryHasRefreshedOnce = false;

const INSTRUMENT_REFRESH_INTERVAL_MS = 3_600_000; // 1 小時（design.md Decision 5）

async function refreshBinance(now: number): Promise<void> {
  try {
    const [exchangeInfo, fundingInfo, premiumIndex] = await Promise.all([
      restClient.getJson<any>({ exchange: 'Binance', url: 'https://fapi.binance.com/fapi/v1/exchangeInfo' }),
      restClient.getJson<any>({ exchange: 'Binance', url: 'https://fapi.binance.com/fapi/v1/fundingInfo' }),
      restClient.getJson<any>({ exchange: 'Binance', url: 'https://fapi.binance.com/fapi/v1/premiumIndex' }),
    ]);
    const items = normalizeBinanceInstruments({
      exchangeInfo: exchangeInfo.data,
      fundingInfo: Array.isArray(fundingInfo.data) ? fundingInfo.data : [],
      premiumIndex: Array.isArray(premiumIndex.data) ? premiumIndex.data : [],
      now,
      onUnknown: (field, value, symbol) =>
        consoleEventSink.emit({
          event_id: crypto.randomUUID(),
          event_type: 'INSTRUMENT_UNKNOWN_VALUE',
          timestamp: now,
          recorded_at: now,
          exchange: 'Binance',
          symbol,
          trade_id: null,
          payload: { field, value },
        }),
    });
    registry.applySnapshot('Binance', items, now);
    registrySuccessfulSourceCount++;
  } catch (err) {
    const upstream = err instanceof UpstreamError ? err : null;
    registry.markSourceFailed('Binance', upstream?.kind ?? 'NETWORK', upstream?.http_status, now);
  }
}

async function refreshBybit(now: number): Promise<void> {
  try {
    const [instrumentsInfo, tickers] = await Promise.all([
      restClient.getJson<any>({ exchange: 'Bybit', url: 'https://api.bybit.com/v5/market/instruments-info?category=linear' }),
      restClient.getJson<any>({ exchange: 'Bybit', url: 'https://api.bybit.com/v5/market/tickers?category=linear' }),
    ]);
    if (instrumentsInfo.data?.retCode !== 0) throw new Error(`Bybit API error: ${instrumentsInfo.data?.retMsg}`);
    const items = normalizeBybitInstruments({
      instrumentsInfo: instrumentsInfo.data?.result?.list ?? [],
      tickers: tickers.data?.result?.list ?? [],
      now,
      onUnknown: (field, value, symbol) =>
        consoleEventSink.emit({
          event_id: crypto.randomUUID(),
          event_type: 'INSTRUMENT_UNKNOWN_VALUE',
          timestamp: now,
          recorded_at: now,
          exchange: 'Bybit',
          symbol,
          trade_id: null,
          payload: { field, value },
        }),
    });
    registry.applySnapshot('Bybit', items, now);
    registrySuccessfulSourceCount++;
  } catch (err) {
    const upstream = err instanceof UpstreamError ? err : null;
    registry.markSourceFailed('Bybit', upstream?.kind ?? 'API_ERROR', upstream?.http_status, now);
  }
}

async function refreshOkx(now: number): Promise<void> {
  try {
    const [instruments, fundingRates] = await Promise.all([
      restClient.getJson<any>({ exchange: 'OKX', url: 'https://www.okx.com/api/v5/public/instruments?instType=SWAP' }),
      restClient.getJson<any>({ exchange: 'OKX', url: 'https://www.okx.com/api/v5/public/funding-rate?instId=ANY' }),
    ]);
    if (instruments.data?.code !== '0') throw new Error(`OKX API error: ${instruments.data?.msg}`);
    const items = normalizeOkxInstruments({
      instruments: instruments.data?.data ?? [],
      fundingRates: fundingRates.data?.data ?? [],
      now,
      onUnknown: (field, value, symbol) =>
        consoleEventSink.emit({
          event_id: crypto.randomUUID(),
          event_type: 'INSTRUMENT_UNKNOWN_VALUE',
          timestamp: now,
          recorded_at: now,
          exchange: 'OKX',
          symbol,
          trade_id: null,
          payload: { field, value },
        }),
    });
    registry.applySnapshot('OKX', items, now);
    registrySuccessfulSourceCount++;
  } catch (err) {
    const upstream = err instanceof UpstreamError ? err : null;
    registry.markSourceFailed('OKX', upstream?.kind ?? 'API_ERROR', upstream?.http_status, now);
  }
}

async function refreshBitget(now: number): Promise<void> {
  try {
    const contracts = await restClient.getJson<any>({
      exchange: 'Bitget',
      url: 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES',
    });
    if (contracts.data?.code !== '00000') throw new Error(`Bitget API error: ${contracts.data?.msg}`);
    // 結算時間不隨本次 metadata 快照提供，由 refreshBitgetFundingSchedule() 以
    // current-fund-rate 批次端點獨立刷新（design.md Decision 5：5 分鐘節奏）。
    const items = normalizeBitgetInstruments({
      contracts: contracts.data?.data ?? [],
      fundingRateSchedule: [],
      now,
      onUnknown: (field, value, symbol) =>
        consoleEventSink.emit({
          event_id: crypto.randomUUID(),
          event_type: 'INSTRUMENT_UNKNOWN_VALUE',
          timestamp: now,
          recorded_at: now,
          exchange: 'Bitget',
          symbol,
          trade_id: null,
          payload: { field, value },
        }),
    });
    registry.applySnapshot('Bitget', items, now);
    registrySuccessfulSourceCount++;
  } catch (err) {
    const upstream = err instanceof UpstreamError ? err : null;
    registry.markSourceFailed('Bitget', upstream?.kind ?? 'API_ERROR', upstream?.http_status, now);
  }
}

async function refreshPionex(now: number): Promise<void> {
  try {
    const [symbols, indexes] = await Promise.all([
      restClient.getJson<any>({ exchange: 'Pionex', url: 'https://api.pionex.com/api/v1/common/symbols?type=PERP' }),
      restClient.getJson<any>({ exchange: 'Pionex', url: 'https://api.pionex.com/api/v1/market/indexes' }),
    ]);
    const items = normalizePionexInstruments({
      symbols: symbols.data?.data?.symbols ?? [],
      indexes: indexes.data?.data?.indexes ?? [],
      now,
      onUnknown: (field, value, symbol) =>
        consoleEventSink.emit({
          event_id: crypto.randomUUID(),
          event_type: 'INSTRUMENT_UNKNOWN_VALUE',
          timestamp: now,
          recorded_at: now,
          exchange: 'Pionex',
          symbol,
          trade_id: null,
          payload: { field, value },
        }),
    });
    registry.applySnapshot('Pionex', items, now);
    registrySuccessfulSourceCount++;
  } catch (err) {
    const upstream = err instanceof UpstreamError ? err : null;
    registry.markSourceFailed('Pionex', upstream?.kind ?? 'NETWORK', upstream?.http_status, now);
  }
}

async function refreshRegistry(): Promise<void> {
  const now = Date.now();
  registrySuccessfulSourceCount = 0;
  await Promise.all([refreshBinance(now), refreshBybit(now), refreshOkx(now), refreshBitget(now), refreshPionex(now)]);
  registryHasRefreshedOnce = true;
  console.log(`[instrument-registry] refresh complete: ${registrySuccessfulSourceCount}/5 sources OK`);
}

// 過渡期的 Bitget 專屬資金費時程刷新迴圈（design.md Decision 5 舊版）已移除
// （task 4.2）：`marketDataService` 的 Bitget `currentFundRate` POLL feed（每 5 分鐘，見
// runtime/src/adapters/bitget/marketData.ts）透過通用的 `fundingService.forwardFundingSchedule`
// 呼叫 `registry.updateFundingSchedule`，涵蓋全部 5 所，不再是 Bitget 專屬特例。

function registrySourcesSnapshot(): Record<string, InstrumentSourceStatus | undefined> {
  const exchanges: ExchangeId[] = ['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'];
  const out: Record<string, InstrumentSourceStatus | undefined> = {};
  for (const ex of exchanges) out[ex] = registry.sourceStatus(ex);
  return out;
}

// 記憶化（market-data-stream spec「Research live-scan served from in-memory market
// state」design.md Decision 8 第 2 點）：聚合結果以 marketState.version() 做快取鍵，
// 至多每 scan_recompute_min_interval_ms（預設 1,000）重算一次；time_to_settlement_sec
// 永遠以「取自快取的 next_funding_time」與本次請求的 now 重新計算（不是快取裡的舊值）。
const SCAN_RECOMPUTE_MIN_INTERVAL_MS = 1_000;
let liveScanAggCache: { version: number; computedAt: number; candidates: ReturnType<typeof buildLiveScanCandidates> } | null = null;

function computeLiveScanCandidates(now: number): ReturnType<typeof buildLiveScanCandidates> {
  const version = marketState.version();
  if (
    liveScanAggCache &&
    liveScanAggCache.version === version &&
    now - liveScanAggCache.computedAt < SCAN_RECOMPUTE_MIN_INTERVAL_MS
  ) {
    // 快取命中：仍對每筆候選的 time_to_settlement_sec 以目前 now 重算（spec 明文：每次回應重算）。
    return liveScanAggCache.candidates.map((c) => ({
      ...c,
      time_to_settlement_sec: Math.max(Math.floor((c.next_funding_time - now) / 1000), 0),
    }));
  }

  const legData = buildLegDataFromMarketState(registry, marketState);
  const instrumentsByKey = new Map<string, ReturnType<typeof registry.list>>();
  for (const instrument of registry.list()) {
    const list = instrumentsByKey.get(instrument.instrument_key) ?? [];
    list.push(instrument);
    instrumentsByKey.set(instrument.instrument_key, list);
  }
  const candidates = buildLiveScanCandidates({
    instrumentsByKey,
    legData,
    now,
    funding_alignment_tolerance_ms: 60_000,
    price_mismatch_tolerance_pct: 0.02,
  });
  liveScanAggCache = { version, computedAt: now, candidates };
  return candidates;
}

/**
 * GET /api/market/live-scan
 * 只讀記憶體行情狀態（websocket-data-layer task 4.2）：請求路徑上不再發出任何上游請求。
 * 支援 `?symbol=` 單一合約篩選；回傳新增 `sources`、`data_as_of`。
 */
app.get('/api/market/live-scan', async (req, res) => {
  try {
    const now = clock.now();

    // 註冊表尚未完成第一次刷新（design.md Decision 9 第 4 點，沿用既有判斷）
    if (!registryHasRefreshedOnce) {
      return res.status(503).json({ success: false, error: 'REGISTRY_NOT_READY' });
    }
    // 行情服務尚未完成第一次全市場快照（market-data-snapshot spec 明文）
    if (!marketDataService.isReady()) {
      return res.status(503).json({ success: false, error: 'MARKET_DATA_NOT_READY', sources: buildSourcesSnapshot(sourceStatus) });
    }

    const t0 = clock.now();
    let candidates = computeLiveScanCandidates(now);
    const fetchLatencyMs = clock.now() - t0;

    const symbolFilter = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
    if (symbolFilter) {
      candidates = candidates.filter((c) => c.symbol === symbolFilter || c.instrument_key === symbolFilter);
    }

    const payload = {
      server_time: now,
      fetch_latency_ms: fetchLatencyMs,
      total_matched_pairs: candidates.length,
      threshold_qualified_count: candidates.filter(c => c.meets_threshold).length,
      exchange_counts: {
        Pionex: candidates.filter(c => c.pionex_rate !== null).length,
        Binance: candidates.filter(c => c.binance_rate !== null).length,
        Bybit: candidates.filter(c => c.bybit_rate !== null).length,
        Bitget: candidates.filter(c => c.bitget_rate !== null).length,
        OKX: candidates.filter(c => c.okx_rate !== null).length,
      },
      candidates,
      registry_sources: registrySourcesSnapshot(),
      sources: buildSourcesSnapshot(sourceStatus),
      data_as_of: buildDataAsOf(sourceStatus),
    };

    return res.json({
      success: true,
      cached: false,
      cache_age_ms: now - (liveScanAggCache?.computedAt ?? now),
      ...payload,
    });
  } catch (err: any) {
    console.error('Error serving 5-exchange live market data:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to serve 5-exchange market data',
    });
  }
});

/**
 * GET /api/latency/ping
 * Measures real latency to Binance, Pionex, Bybit, Bitget, OKX
 */
app.get('/api/latency/ping', async (_req, res) => {
  const pings: Record<string, number> = {
    Binance: -1,
    Pionex: -1,
    Bybit: -1,
    Bitget: -1,
    OKX: -1,
  };

  const tasks = [
    (async () => {
      const s = Date.now();
      await fetch('https://fapi.binance.com/fapi/v1/ping', { signal: AbortSignal.timeout(3000) });
      pings.Binance = Date.now() - s;
    })().catch(() => {}),
    (async () => {
      const s = Date.now();
      await fetch('https://api.pionex.com/api/v1/market/indexes', { signal: AbortSignal.timeout(3000) });
      pings.Pionex = Date.now() - s;
    })().catch(() => {}),
    (async () => {
      const s = Date.now();
      await fetch('https://api.bybit.com/v5/market/time', { signal: AbortSignal.timeout(3000) });
      pings.Bybit = Date.now() - s;
    })().catch(() => {}),
    (async () => {
      const s = Date.now();
      await fetch('https://api.bitget.com/api/v2/public/time', { signal: AbortSignal.timeout(3000) });
      pings.Bitget = Date.now() - s;
    })().catch(() => {}),
    (async () => {
      const s = Date.now();
      await fetch('https://www.okx.com/api/v5/public/time', { signal: AbortSignal.timeout(3000) });
      pings.OKX = Date.now() - s;
    })().catch(() => {}),
  ];

  await Promise.all(tasks);

  return res.json({
    pings,
    server_time: Date.now(),
  });
});

/**
 * GET /api/market/live-klines?symbol=BTCUSDT
 */
app.get('/api/market/live-klines', async (req, res) => {
  try {
    const rawSymbol = (req.query.symbol as string) || 'BTCUSDT';
    const resolution = resolveKlinesSymbol(rawSymbol, registry);
    if (!resolution.ok) {
      return res.status(400).json({ success: false, error: resolution.reason });
    }
    const { binance_native_symbol: symbol, pionex_native_symbol: pxSymbol } = resolution.resolution;

    const binanceUrl = new URL('https://fapi.binance.com/fapi/v1/klines');
    binanceUrl.searchParams.set('symbol', symbol);
    binanceUrl.searchParams.set('interval', '1m');
    binanceUrl.searchParams.set('limit', '10');

    const errors: Record<string, string> = {};

    const bnRes = await fetch(binanceUrl.toString(), { signal: AbortSignal.timeout(5000) })
      .then(async (r) => {
        if (!r.ok) {
          errors.binance = `HTTP ${r.status}`;
          return [];
        }
        return r.json();
      })
      .catch((err) => {
        errors.binance = err.message;
        return [];
      });

    let pionexBars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    if (pxSymbol) {
      const pionexUrl = new URL('https://api.pionex.com/api/v1/market/klines');
      pionexUrl.searchParams.set('symbol', pxSymbol);
      pionexUrl.searchParams.set('interval', '1M');
      pionexUrl.searchParams.set('limit', '10');

      const pxRes = await fetch(pionexUrl.toString(), { signal: AbortSignal.timeout(5000) })
        .then(async (r) => {
          if (!r.ok) {
            errors.pionex = `HTTP ${r.status}`;
            return { data: { klines: [] } };
          }
          return r.json();
        })
        .catch((err) => {
          errors.pionex = err.message;
          return { data: { klines: [] } };
        });

      pionexBars = pxRes?.data?.klines
        ? pxRes.data.klines.slice(0, 5).reverse().map((bar: any) => ({
            time: bar.time,
            open: parseFloat(bar.open),
            high: parseFloat(bar.high),
            low: parseFloat(bar.low),
            close: parseFloat(bar.close),
            volume: parseFloat(bar.volume),
          }))
        : [];
    } else {
      errors.pionex = 'NOT_FOUND';
    }

    const binanceBars = Array.isArray(bnRes)
      ? bnRes.slice(-5).map((bar: any) => ({
          time: bar[0],
          open: parseFloat(bar[1]),
          high: parseFloat(bar[2]),
          low: parseFloat(bar[3]),
          close: parseFloat(bar[4]),
          volume: parseFloat(bar[7]),
        }))
      : [];

    return res.json({
      success: true,
      symbol,
      pionex_symbol: pxSymbol,
      binance_bars: binanceBars,
      pionex_bars: pionexBars,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- runtime-health-reconciliation wiring (task 3.2) -----------------------
// server.ts 不在 runtime/src/ 內，可直接讀系統時間（同上方 instrument-registry 註解）；
// 這兩個路由唯讀 SQLite（design.md Decision 3：C-06 server 只唯讀，不開 IPC/port）。
// 每次請求各自開一個 `readOnly: true` 連線、用完即關閉——避免跨 Runtime 重啟持有過期 handle
// 或寫鎖（design.md Risks "SQLite 多 process 讀寫"：WAL 模式允許一寫多讀）。

const PAPER_DB_PATH = process.env.PAPER_DB_PATH ?? path.resolve(process.cwd(), 'data', 'paper.sqlite');
// `health_publish_interval_ms` 預設值待 Runtime 啟動流程（task 4.1 main.ts）正式組裝
// `HealthConfig` 後接手；這裡先用同一個預設值獨立算「3 倍間隔」失聯閾值
// （design.md Decision 3「失聯閾值 3 倍間隔吸收兩者偏差」），避免硬編一個與 Runtime
// 實際發佈頻率脫鉤的門檻。
const HEALTH_PUBLISH_INTERVAL_MS = 2_000;
const HEALTH_STALE_THRESHOLD_MS = HEALTH_PUBLISH_INTERVAL_MS * 3;

/** Opens a fresh read-only `node:sqlite` connection; `undefined` if the Runtime DB doesn't exist yet (fresh install / Runtime never started). */
function openPaperDbReadOnly(): DatabaseSync | undefined {
  try {
    return new DatabaseSync(PAPER_DB_PATH, { readOnly: true });
  } catch {
    return undefined;
  }
}

/**
 * GET /api/paper/health
 * 唯讀 Runtime Health（2026-10-03 由 `/api/runtime/health` 改名，見 proposal.md「What
 * Changes」）。失聯（DB 不存在 / `runtime_health` 無列 / heartbeat 超過 3 倍發佈間隔）
 * 回 `engine: 'UNREACHABLE'`。回應絕不含憑證本體，只有 `credentials` 狀態字串。
 */
app.get('/api/paper/health', (_req, res) => {
  const reader = openPaperDbReadOnly();
  try {
    const row = reader ? readRuntimeHealthRow(reader) : undefined;
    const payload = buildHealthApiPayload(row, { nowMs: Date.now(), staleThresholdMs: HEALTH_STALE_THRESHOLD_MS });
    return res.json(payload);
  } catch (err: any) {
    console.error('[runtime-health] /api/paper/health failed:', err);
    return res.status(500).json({ error: err.message || 'HEALTH_READ_FAILED' });
  } finally {
    reader?.close();
  }
});

/**
 * GET /api/runtime/reconciliation/latest
 * 內部/維運用唯讀端點（非 UI 契約）：最近一次對帳 run 的紀錄，沒有任何 run 時回 `{ run: null }`。
 */
app.get('/api/runtime/reconciliation/latest', (_req, res) => {
  const reader = openPaperDbReadOnly();
  try {
    const row = reader ? readLatestReconciliationRun(reader) : undefined;
    return res.json(buildReconciliationLatestPayload(row));
  } catch (err: any) {
    console.error('[runtime-health] /api/runtime/reconciliation/latest failed:', err);
    return res.status(500).json({ error: err.message || 'RECONCILIATION_READ_FAILED' });
  } finally {
    reader?.close();
  }
});

// --- paper-trading-read-api wiring (tasks 1.1/2.1) --------------------------
// 唯讀四條 Paper Trading 資料路由（design.md Decision 1/4）：每次請求各自開一個
// `readOnly: true` 連線、用完即關閉（沿用 runtime-health-reconciliation 的慣例，
// `server/paperReadLayer.ts` 自己的 `openPaperDb` helper，不共用上面 health 用的
// `openPaperDbReadOnly`——design.md Decision 1「保持檔案/目錄邊界」）。
// `PaperReadLayerUnavailableError`（DB/表不存在、或帳戶快照尚無資料）統一回 503；
// 未知 `trade_id` 回 404；格式錯誤的 `cursor` 回 400（design.md Decision 4）。

/**
 * GET /api/paper/account
 * 回真實 `AccountSnapshot`（`runtime/src/types/account.ts`），非 design.md 原始
 * A-5 文字形狀（design.md Context「A-5 已過期」）。
 */
app.get('/api/paper/account', (_req, res) => {
  const reader = openPaperReadDb(PAPER_DB_PATH);
  try {
    const snapshot = getAccountSnapshot(reader);
    return res.json(snapshot);
  } catch (err) {
    if (err instanceof PaperReadLayerUnavailableError) {
      return res.status(503).json({ error: err.message });
    }
    console.error('[paper-trading-read-api] /api/paper/account failed:', err);
    return res.status(500).json({ error: 'ACCOUNT_READ_FAILED' });
  } finally {
    reader?.close();
  }
});

/**
 * GET /api/paper/trades?scope=current|completed
 * current：警示狀態優先排序、群內 `created_at` 新到舊，無分頁。
 * completed：keyset 分頁（`finalized_at ?? updated_at` desc + `trade_id` tie-break）、
 * 可選 `final_status` 篩選、可選 `cursor`/`limit`（預設 50）。
 */
app.get('/api/paper/trades', (req, res) => {
  const scope = req.query.scope;
  const reader = openPaperReadDb(PAPER_DB_PATH);
  try {
    if (scope === 'current') {
      const items = getCurrentTrades(reader);
      return res.json({ items });
    }
    if (scope === 'completed') {
      const finalStatusParam = typeof req.query.final_status === 'string' ? req.query.final_status : undefined;
      const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
      try {
        const page = getCompletedTrades(
          reader,
          finalStatusParam ? { final_status: finalStatusParam as never } : {},
          cursorParam,
          limit,
        );
        return res.json(page);
      } catch (err) {
        if (err instanceof MalformedCursorError) {
          return res.status(400).json({ error: 'MALFORMED_CURSOR' });
        }
        throw err;
      }
    }
    return res.status(400).json({ error: 'INVALID_SCOPE' });
  } catch (err) {
    if (err instanceof PaperReadLayerUnavailableError) {
      return res.status(503).json({ error: err.message });
    }
    console.error('[paper-trading-read-api] /api/paper/trades failed:', err);
    return res.status(500).json({ error: 'TRADES_READ_FAILED' });
  } finally {
    reader?.close();
  }
});

/**
 * GET /api/paper/trades/:trade_id
 * `TradeDetail { trade, legs, orders, fills, funding_settlements, opportunity, result? }`；
 * 未知 `trade_id` 回 404。
 */
app.get('/api/paper/trades/:trade_id', (req, res) => {
  const reader = openPaperReadDb(PAPER_DB_PATH);
  try {
    const detail = getTradeDetail(reader, req.params.trade_id);
    if (!detail) return res.status(404).json({ error: 'TRADE_NOT_FOUND' });
    return res.json(detail);
  } catch (err) {
    if (err instanceof PaperReadLayerUnavailableError) {
      return res.status(503).json({ error: err.message });
    }
    console.error('[paper-trading-read-api] /api/paper/trades/:trade_id failed:', err);
    return res.status(500).json({ error: 'TRADE_DETAIL_READ_FAILED' });
  } finally {
    reader?.close();
  }
});

/**
 * GET /api/paper/trades/:trade_id/events?cursor=&limit=
 * `seq` 升冪、keyset 分頁（重用 `paperCursor.ts`）；未知 `trade_id` 回 404；
 * 格式錯誤的 `cursor` 回 400。
 */
app.get('/api/paper/trades/:trade_id/events', (req, res) => {
  const reader = openPaperReadDb(PAPER_DB_PATH);
  try {
    const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 200;
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200;
    try {
      const page = getTradeEvents(reader, req.params.trade_id, cursorParam, limit);
      if (!page) return res.status(404).json({ error: 'TRADE_NOT_FOUND' });
      return res.json(page);
    } catch (err) {
      if (err instanceof MalformedCursorError) {
        return res.status(400).json({ error: 'MALFORMED_CURSOR' });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof PaperReadLayerUnavailableError) {
      return res.status(503).json({ error: err.message });
    }
    console.error('[paper-trading-read-api] /api/paper/trades/:trade_id/events failed:', err);
    return res.status(500).json({ error: 'TRADE_EVENTS_READ_FAILED' });
  } finally {
    reader?.close();
  }
});

async function start() {
  // 非阻塞啟動刷新（design.md Decision 9 第 2 點）：app.listen 不等待註冊表就緒。
  refreshRegistry().catch(err => console.error('[instrument-registry] initial refresh failed:', err));
  setInterval(() => {
    refreshRegistry().catch(err => console.error('[instrument-registry] periodic refresh failed:', err));
  }, INSTRUMENT_REFRESH_INTERVAL_MS);

  // websocket-data-layer（task 4.2）：行情服務獨立於註冊表 metadata 刷新啟動；
  // RealClock 先做一次校正樣本，再啟動全市場層輪詢 / 串流，之後每 30 s 重新校正。
  await calibrateClock().catch(err => console.error('[market-data] initial clock calibration failed:', err));
  marketDataService.start();
  setInterval(() => {
    calibrateClock().catch(err => console.error('[market-data] periodic clock calibration failed:', err));
  }, SERVER_TIME_CALIBRATION_INTERVAL_MS);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[5-Exchange Arbitrage Engine] Server listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
