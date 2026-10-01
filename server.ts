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
import { buildLiveScanCandidates, type LiveScanLegData } from './server/liveScanRegistry';
import { resolveKlinesSymbol } from './server/liveKlinesResolve';
import { InstrumentRegistry } from './runtime/src/market/instruments/registry';
import { BasicRestClient, UpstreamError } from './runtime/src/market/http/publicRestClient';
import { normalizeBinanceInstruments } from './runtime/src/adapters/binance/instruments';
import { normalizeBybitInstruments } from './runtime/src/adapters/bybit/instruments';
import { normalizeOkxInstruments } from './runtime/src/adapters/okx/instruments';
import { normalizeBitgetInstruments } from './runtime/src/adapters/bitget/instruments';
import { normalizePionexInstruments } from './runtime/src/adapters/pionex/instruments';
import { mapBitgetFundingRateSchedule } from './server/bitgetFundingSchedule';
import type { ExchangeId, EventSink, TradingEvent, InstrumentSourceStatus } from './runtime/src/market/instruments/types';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory cache for live market data to protect exchange rate limits (5-second cache)
let liveScanCache: { timestamp: number; data: any } | null = null;
const CACHE_TTL_MS = 5000;

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
const restClient = new BasicRestClient({ localNow: () => Date.now() });

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

// --- Bitget 資金費時程獨立刷新（design.md Decision 5）---
// GET current-fund-rate?productType=USDT-FUTURES 不帶 symbol 即批次回傳全部合約
// （2026-10-01 實測：825 筆、單次請求），每 5 分鐘刷新一次；偵測到 STALE 時可提前刷新，
// 但同所兩次間隔 ≥ 30 秒。
const BITGET_FUNDING_SCHEDULE_REFRESH_INTERVAL_MS = 300_000;
const BITGET_FUNDING_SCHEDULE_MIN_REFRESH_GAP_MS = 30_000;
let lastBitgetFundingScheduleRefreshAt = 0;

async function refreshBitgetFundingSchedule(now: number): Promise<void> {
  lastBitgetFundingScheduleRefreshAt = now;
  try {
    const res = await restClient.getJson<any>({
      exchange: 'Bitget',
      url: 'https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES',
    });
    if (res.data?.code !== '00000') throw new Error(`Bitget API error: ${res.data?.msg}`);
    const entries = mapBitgetFundingRateSchedule(res.data?.data ?? [], now);
    for (const entry of entries) {
      registry.updateFundingSchedule('Bitget', entry.native_symbol, entry.update, now);
    }
    console.log(`[instrument-registry] Bitget funding schedule refreshed: ${entries.length} symbols`);
  } catch (err) {
    console.error('[instrument-registry] Bitget funding schedule refresh failed:', err);
  }
}

/** 偵測 Bitget 是否有 TRADING 合約的結算時程為 STALE，若有且距上次刷新 ≥ 30 秒則提前刷新。 */
async function refreshBitgetFundingScheduleIfStale(now: number): Promise<void> {
  if (now - lastBitgetFundingScheduleRefreshAt < BITGET_FUNDING_SCHEDULE_MIN_REFRESH_GAP_MS) return;
  const hasStale = registry
    .list({ exchange: 'Bitget', status: 'TRADING' })
    .some((i) => i.funding.schedule_status === 'STALE');
  if (hasStale) {
    await refreshBitgetFundingSchedule(now);
  }
}

function registrySourcesSnapshot(): Record<string, InstrumentSourceStatus | undefined> {
  const exchanges: ExchangeId[] = ['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'];
  const out: Record<string, InstrumentSourceStatus | undefined> = {};
  for (const ex of exchanges) out[ex] = registry.sourceStatus(ex);
  return out;
}

/**
 * GET /api/market/live-scan
 * Fetches real-time funding rates from all 5 exchanges: Pionex, Binance, Bybit, Bitget, OKX
 */
app.get('/api/market/live-scan', async (_req, res) => {
  try {
    const now = Date.now();

    // 註冊表尚未完成第一次刷新（design.md Decision 9 第 4 點）
    if (!registryHasRefreshedOnce) {
      return res.status(503).json({ success: false, error: 'REGISTRY_NOT_READY' });
    }

    if (liveScanCache && now - liveScanCache.timestamp < CACHE_TTL_MS) {
      return res.json({
        success: true,
        cached: true,
        cache_age_ms: now - liveScanCache.timestamp,
        ...liveScanCache.data,
      });
    }

    // Bitget 結算時間經獨立 5 分鐘刷新提供；若已 STALE 且距上次刷新 ≥30 秒則提前刷新
    // （design.md Decision 5 / Risks「Bitget 結算時間由 5 分鐘刷新提供，結算後短暫 STALE」）。
    await refreshBitgetFundingScheduleIfStale(now);

    const t0 = Date.now();

    const bnPromise = fetch('https://fapi.binance.com/fapi/v1/premiumIndex', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => []);

    const pxPromise = fetch('https://api.pionex.com/api/v1/market/indexes', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: { indexes: [] } }));

    const pxTickersPromise = fetch('https://api.pionex.com/api/v1/market/tickers?type=PERP', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: { tickers: [] } }));

    const bybitPromise = fetch('https://api.bybit.com/v5/market/tickers?category=linear', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ result: { list: [] } }));

    const bitgetPromise = fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: [] }));

    const okxTickersPromise = fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: [] }));

    const okxFundingPromise = fetch('https://www.okx.com/api/v5/public/funding-rate?instId=ANY', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: [] }));

    const bn24hPromise = fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => []);

    const [bnData, pxData, pxTickersData, bybitData, bitgetData, okxTickersData, okxFundingData, bn24hData] = await Promise.all([
      bnPromise,
      pxPromise,
      pxTickersPromise,
      bybitPromise,
      bitgetPromise,
      okxTickersPromise,
      okxFundingPromise,
      bn24hPromise,
    ]);

    const fetchLatencyMs = Date.now() - t0;

    // instrument_id -> live leg data（費率 / 標記價 / 24h 量）
    const legData = new Map<string, LiveScanLegData>();

    function setLeg(exchange: ExchangeId, nativeSymbol: string, rate: number, mark: number): void {
      const instrument = registry.get(exchange, nativeSymbol);
      if (!instrument) return;
      const existing = legData.get(instrument.instrument_id);
      legData.set(instrument.instrument_id, { rate, mark, volume_24h: existing?.volume_24h ?? null });
    }

    function setVolume(exchange: ExchangeId, nativeSymbol: string, volume: number): void {
      const instrument = registry.get(exchange, nativeSymbol);
      if (!instrument) return;
      const existing = legData.get(instrument.instrument_id);
      if (existing) {
        existing.volume_24h = volume;
      } else {
        legData.set(instrument.instrument_id, { rate: NaN, mark: NaN, volume_24h: volume });
      }
    }

    // Binance
    if (Array.isArray(bnData)) {
      for (const item of bnData) {
        if (!item.symbol?.endsWith('USDT')) continue;
        setLeg('Binance', item.symbol, parseFloat(item.lastFundingRate || '0'), parseFloat(item.markPrice || '0'));
        if (item.nextFundingTime) {
          registry.updateFundingSchedule('Binance', item.symbol, { next_funding_time: item.nextFundingTime, exchange_timestamp: now }, now);
        }
      }
    }
    if (Array.isArray(bn24hData)) {
      for (const item of bn24hData) {
        if (item.symbol?.endsWith('USDT') && item.quoteVolume) {
          setVolume('Binance', item.symbol, parseFloat(item.quoteVolume));
        }
      }
    }

    // Pionex
    const pxIndexes = pxData?.data?.indexes || [];
    if (Array.isArray(pxIndexes)) {
      for (const item of pxIndexes) {
        if (!item.symbol?.endsWith('_PERP')) continue;
        setLeg('Pionex', item.symbol, parseFloat(item.nextFundingRate || '0'), parseFloat(item.markPrice || '0'));
        if (item.nextFundingTime) {
          registry.updateFundingSchedule('Pionex', item.symbol, { next_funding_time: item.nextFundingTime, exchange_timestamp: now }, now);
        }
      }
    }
    const pxTickers = pxTickersData?.data?.tickers || [];
    if (Array.isArray(pxTickers)) {
      for (const item of pxTickers) {
        if (item.symbol && item.amount) {
          setVolume('Pionex', item.symbol, parseFloat(item.amount));
        }
      }
    }

    // Bybit
    const bybitList = bybitData?.result?.list || [];
    if (Array.isArray(bybitList)) {
      for (const item of bybitList) {
        if (!item.symbol?.endsWith('USDT')) continue;
        setLeg('Bybit', item.symbol, parseFloat(item.fundingRate || '0'), parseFloat(item.markPrice || '0'));
        if (item.nextFundingTime) {
          registry.updateFundingSchedule('Bybit', item.symbol, { next_funding_time: parseInt(item.nextFundingTime), exchange_timestamp: now }, now);
        }
        if (item.turnover24h) {
          setVolume('Bybit', item.symbol, parseFloat(item.turnover24h));
        }
      }
    }

    // Bitget
    const bitgetList = bitgetData?.data || [];
    if (Array.isArray(bitgetList)) {
      for (const item of bitgetList) {
        if (!item.symbol?.endsWith('USDT')) continue;
        setLeg('Bitget', item.symbol, parseFloat(item.fundingRate || '0'), parseFloat(item.markPrice || '0'));
        if (item.usdtVolume) {
          setVolume('Bitget', item.symbol, parseFloat(item.usdtVolume));
        }
      }
    }

    // OKX
    const okxRawList = okxTickersData?.data || [];
    const okxUsdtSwaps = Array.isArray(okxRawList) ? okxRawList.filter((t: any) => t.instId && t.instId.endsWith('-USDT-SWAP')) : [];
    const okxFundingList = okxFundingData?.data || [];
    const okxRatesMap = new Map<string, { rate: number; nextFundingTime: number }>();
    if (Array.isArray(okxFundingList)) {
      for (const item of okxFundingList) {
        if (item.instId && item.fundingRate) {
          okxRatesMap.set(item.instId, { rate: parseFloat(item.fundingRate), nextFundingTime: parseInt(item.fundingTime || item.nextFundingTime || '0') });
        }
      }
    }
    for (const t of okxUsdtSwaps) {
      const info = okxRatesMap.get(t.instId);
      if (!info) continue;
      setLeg('OKX', t.instId, info.rate, parseFloat(t.last || '0'));
      if (info.nextFundingTime) {
        registry.updateFundingSchedule('OKX', t.instId, { next_funding_time: info.nextFundingTime, exchange_timestamp: now }, now);
      }
      if (t.volCcy24h && t.last) {
        setVolume('OKX', t.instId, parseFloat(t.volCcy24h) * parseFloat(t.last));
      }
    }

    // 以 instrument_key 分組所有已登錄合約（不限於本次有即時資料者，matching 會自行比對）
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
    };

    liveScanCache = { timestamp: now, data: payload };

    return res.json({
      success: true,
      cached: false,
      ...payload,
    });
  } catch (err: any) {
    console.error('Error fetching 5-exchange live market data:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to fetch 5-exchange market data',
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

async function start() {
  // 非阻塞啟動刷新（design.md Decision 9 第 2 點）：app.listen 不等待註冊表就緒。
  refreshRegistry()
    .then(() => refreshBitgetFundingSchedule(Date.now()))
    .catch(err => console.error('[instrument-registry] initial refresh failed:', err));
  setInterval(() => {
    refreshRegistry().catch(err => console.error('[instrument-registry] periodic refresh failed:', err));
  }, INSTRUMENT_REFRESH_INTERVAL_MS);
  setInterval(() => {
    refreshBitgetFundingSchedule(Date.now()).catch(err => console.error('[instrument-registry] Bitget funding schedule periodic refresh failed:', err));
  }, BITGET_FUNDING_SCHEDULE_REFRESH_INTERVAL_MS);

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
