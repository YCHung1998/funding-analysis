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
import { extractBaseSymbol, findBestPair, resolveSettlement, computeLiveScanNetPnl } from './server/liveScanMath';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory cache for live market data to protect exchange rate limits (5-second cache)
let liveScanCache: { timestamp: number; data: any } | null = null;
const CACHE_TTL_MS = 5000;

// In-memory cache for OKX funding rates (30s TTL to prevent spamming individual queries)
const okxFundingRateCache = new Map<string, { rate: number; nextFundingTime: number; ts: number }>();

export type ExchangeName = 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';

/**
 * GET /api/market/live-scan
 * Fetches real-time funding rates from all 5 exchanges: Pionex, Binance, Bybit, Bitget, OKX
 */
app.get('/api/market/live-scan', async (_req, res) => {
  try {
    const now = Date.now();
    if (liveScanCache && now - liveScanCache.timestamp < CACHE_TTL_MS) {
      return res.json({
        success: true,
        cached: true,
        cache_age_ms: now - liveScanCache.timestamp,
        ...liveScanCache.data,
      });
    }

    const t0 = Date.now();

    // 1. Binance USD-M Futures Premium Index
    const bnPromise = fetch('https://fapi.binance.com/fapi/v1/premiumIndex', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => []);

    // 2. Pionex Futures Indexes
    const pxPromise = fetch('https://api.pionex.com/api/v1/market/indexes', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: { indexes: [] } }));

    // 3. Bybit Linear Tickers
    const bybitPromise = fetch('https://api.bybit.com/v5/market/tickers?category=linear', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ result: { list: [] } }));

    // 4. Bitget USDT-Futures Tickers
    const bitgetPromise = fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: [] }));

    // 5. OKX SWAP Tickers & Bulk Funding Rates
    const okxTickersPromise = fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: [] }));

    const okxFundingPromise = fetch('https://www.okx.com/api/v5/public/funding-rate?instId=ANY', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => ({ data: [] }));

    // 6. Binance 24h Tickers for volumes
    const bn24hPromise = fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', {
      headers: { 'User-Agent': 'ArbEngine/1.0' },
      signal: AbortSignal.timeout(6000),
    }).then(r => r.json()).catch(() => []);

    const [bnData, pxData, bybitData, bitgetData, okxTickersData, okxFundingData, bn24hData] = await Promise.all([
      bnPromise,
      pxPromise,
      bybitPromise,
      bitgetPromise,
      okxTickersPromise,
      okxFundingPromise,
      bn24hPromise,
    ]);

    // Index volumes by base
    const volumeMap = new Map<string, number>();
    if (Array.isArray(bn24hData)) {
      for (const item of bn24hData) {
        if (item.symbol?.endsWith('USDT') && item.quoteVolume) {
          const base = extractBaseSymbol(item.symbol);
          volumeMap.set(base, parseFloat(item.quoteVolume));
        }
      }
    }

    // Process OKX funding rates map from bulk instId=ANY
    const okxRatesMap = new Map<string, { rate: number; nextFundingTime: number }>();
    const okxFundingList = okxFundingData?.data || [];
    if (Array.isArray(okxFundingList)) {
      for (const item of okxFundingList) {
        if (item.instId && item.fundingRate) {
          const rate = parseFloat(item.fundingRate);
          const nextTime = parseInt(item.fundingTime || item.nextFundingTime || `${now + 8 * 3600 * 1000}`);
          okxRatesMap.set(item.instId, { rate, nextFundingTime: nextTime });
        }
      }
    }

    const okxRawList = okxTickersData?.data || [];
    const okxUsdtSwaps = okxRawList.filter((t: any) => t.instId && t.instId.endsWith('-USDT-SWAP'));

    const fetchLatencyMs = Date.now() - t0;

    interface SymbolAggregate {
      base: string;
      displaySymbol: string;
      rates: Partial<Record<ExchangeName, number>>;
      marks: Partial<Record<ExchangeName, number>>;
      nextFundingTimes: Partial<Record<ExchangeName, number>>;
      rawSymbols: Partial<Record<ExchangeName, string>>;
      intervals: Partial<Record<ExchangeName, number>>;
      volume24h: number;
    }

    const symbolMap = new Map<string, SymbolAggregate>();

    function getOrCreate(base: string, displaySymbol: string): SymbolAggregate {
      if (!symbolMap.has(base)) {
        symbolMap.set(base, {
          base,
          displaySymbol: displaySymbol.endsWith('USDT') ? displaySymbol : `${displaySymbol}USDT`,
          rates: {},
          marks: {},
          nextFundingTimes: {},
          rawSymbols: {},
          intervals: {},
          volume24h: volumeMap.get(base) || 10000000,
        });
      }
      return symbolMap.get(base)!;
    }

    // Process Binance
    if (Array.isArray(bnData)) {
      for (const item of bnData) {
        if (!item.symbol?.endsWith('USDT')) continue;
        const base = extractBaseSymbol(item.symbol);
        const agg = getOrCreate(base, item.symbol);
        agg.rates['Binance'] = parseFloat(item.lastFundingRate || '0');
        agg.marks['Binance'] = parseFloat(item.markPrice || '0');
        agg.nextFundingTimes['Binance'] = item.nextFundingTime || (now + 8 * 3600 * 1000);
        agg.rawSymbols['Binance'] = item.symbol;
        agg.intervals['Binance'] = 8;
      }
    }

    // Process Pionex
    const pxIndexes = pxData?.data?.indexes || [];
    if (Array.isArray(pxIndexes)) {
      for (const item of pxIndexes) {
        if (!item.symbol?.endsWith('_PERP')) continue;
        const base = extractBaseSymbol(item.symbol);
        const agg = getOrCreate(base, item.symbol.replace('_PERP', '').replace('_', ''));
        agg.rates['Pionex'] = parseFloat(item.nextFundingRate || '0');
        agg.marks['Pionex'] = parseFloat(item.markPrice || '0');
        agg.nextFundingTimes['Pionex'] = item.nextFundingTime || (now + 8 * 3600 * 1000);
        agg.rawSymbols['Pionex'] = item.symbol;
        const diffHrs = ((item.nextFundingTime || (now + 8 * 3600 * 1000)) - now) / 3600000;
        agg.intervals['Pionex'] = diffHrs <= 1.2 ? 1 : diffHrs <= 4.2 ? 4 : 8;
      }
    }

    // Process Bybit
    const bybitList = bybitData?.result?.list || [];
    if (Array.isArray(bybitList)) {
      for (const item of bybitList) {
        if (!item.symbol?.endsWith('USDT')) continue;
        const base = extractBaseSymbol(item.symbol);
        const agg = getOrCreate(base, item.symbol);
        agg.rates['Bybit'] = parseFloat(item.fundingRate || '0');
        agg.marks['Bybit'] = parseFloat(item.markPrice || '0');
        agg.nextFundingTimes['Bybit'] = parseInt(item.nextFundingTime || `${now + 8 * 3600 * 1000}`);
        agg.rawSymbols['Bybit'] = item.symbol;
        agg.intervals['Bybit'] = parseInt(item.fundingIntervalHour || '8') || 8;
      }
    }

    // Process Bitget
    const bitgetList = bitgetData?.data || [];
    if (Array.isArray(bitgetList)) {
      for (const item of bitgetList) {
        if (!item.symbol?.endsWith('USDT')) continue;
        const base = extractBaseSymbol(item.symbol);
        const agg = getOrCreate(base, item.symbol);
        agg.rates['Bitget'] = parseFloat(item.fundingRate || '0');
        agg.marks['Bitget'] = parseFloat(item.markPrice || '0');
        agg.rawSymbols['Bitget'] = item.symbol;
        agg.intervals['Bitget'] = 8;
      }
    }

    // Process OKX
    for (const t of okxUsdtSwaps) {
      const base = extractBaseSymbol(t.instId);
      const agg = getOrCreate(base, `${base}USDT`);
      const okxInfo = okxRatesMap.get(t.instId);
      if (okxInfo) {
        agg.rates['OKX'] = okxInfo.rate;
        agg.nextFundingTimes['OKX'] = okxInfo.nextFundingTime;
      }
      agg.marks['OKX'] = parseFloat(t.last || '0');
      agg.rawSymbols['OKX'] = t.instId;
      agg.intervals['OKX'] = 8;
    }

    // Form arbitrage opportunities across all 5 exchanges
    const matchedCandidates: any[] = [];
    const EXCHANGES: ExchangeName[] = ['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'];

    for (const agg of symbolMap.values()) {
      const pair = findBestPair(agg.rates, EXCHANGES);
      if (!pair) continue;
      const { activeExchanges, maxSpread, bestLongEx, bestShortEx, pairSpreads } = pair;

      const { nextFundingTime, timeToSettlementSec, intervalHours } = resolveSettlement(agg.nextFundingTimes, agg.intervals, now);

      const volume24h = agg.volume24h;
      const netPnl = computeLiveScanNetPnl(maxSpread, volume24h);

      matchedCandidates.push({
        symbol: agg.displaySymbol,
        base: agg.base,
        available_exchanges: activeExchanges,
        // Individual rates for all 5 exchanges
        pionex_rate: agg.rates['Pionex'] ?? null,
        binance_rate: agg.rates['Binance'] ?? null,
        bybit_rate: agg.rates['Bybit'] ?? null,
        bitget_rate: agg.rates['Bitget'] ?? null,
        okx_rate: agg.rates['OKX'] ?? null,
        // Raw marks
        pionex_mark: agg.marks['Pionex'] ?? null,
        binance_mark: agg.marks['Binance'] ?? null,
        bybit_mark: agg.marks['Bybit'] ?? null,
        bitget_mark: agg.marks['Bitget'] ?? null,
        okx_mark: agg.marks['OKX'] ?? null,
        // Best opportunity
        spread: maxSpread,
        best_pair: {
          long_exchange: bestLongEx,
          short_exchange: bestShortEx,
          pair_label: `Long ${bestLongEx} / Short ${bestShortEx}`,
          spread: maxSpread,
        },
        pair_spreads: pairSpreads,
        next_funding_time: nextFundingTime,
        time_to_settlement_sec: timeToSettlementSec,
        interval_hours: intervalHours,
        volume_24h: volume24h,
        est_slippage_pct: netPnl.estSlippagePct,
        fee_drag_pct: netPnl.feeDragPct,
        expected_net_pnl_pct: netPnl.expectedNetPnlPct,
        expected_net_pnl_usdt: netPnl.expectedNetPnlUsdt,
        meets_threshold: netPnl.meetsThreshold,
      });
    }

    matchedCandidates.sort((a, b) => b.spread - a.spread);
    matchedCandidates.forEach((c, idx) => {
      c.rank = idx + 1;
    });

    const payload = {
      server_time: now,
      fetch_latency_ms: fetchLatencyMs,
      total_matched_pairs: matchedCandidates.length,
      threshold_qualified_count: matchedCandidates.filter(c => c.meets_threshold).length,
      exchange_counts: {
        Pionex: matchedCandidates.filter(c => c.pionex_rate !== null).length,
        Binance: matchedCandidates.filter(c => c.binance_rate !== null).length,
        Bybit: matchedCandidates.filter(c => c.bybit_rate !== null).length,
        Bitget: matchedCandidates.filter(c => c.bitget_rate !== null).length,
        OKX: matchedCandidates.filter(c => c.okx_rate !== null).length,
      },
      candidates: matchedCandidates,
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
    const symbol = (req.query.symbol as string || 'BTCUSDT').toUpperCase();
    const pxSymbol = symbol.endsWith('USDT')
      ? `${symbol.replace('USDT', '')}_USDT_PERP`
      : `${symbol}_PERP`;

    const [bnRes, pxRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=10`, {
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => []),
      fetch(`https://api.pionex.com/api/v1/market/klines?symbol=${pxSymbol}&interval=1M&limit=10`, {
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ data: { klines: [] } })),
    ]);

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

    const pionexBars = pxRes?.data?.klines
      ? pxRes.data.klines.slice(0, 5).reverse().map((bar: any) => ({
          time: bar.time,
          open: parseFloat(bar.open),
          high: parseFloat(bar.high),
          low: parseFloat(bar.low),
          close: parseFloat(bar.close),
          volume: parseFloat(bar.volume),
        }))
      : [];

    return res.json({
      success: true,
      symbol,
      pionex_symbol: pxSymbol,
      binance_bars: binanceBars,
      pionex_bars: pionexBars,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

async function start() {
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
