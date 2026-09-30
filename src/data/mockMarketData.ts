/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Historical & Simulated Settlement Datasets for Pionex × Binance Spec v0.1
 * Includes synchronized 5-bar 1m Klines (T-2m, T-1m, T, T+1m, T+2m) & Volume shocks.
 */

import { PionexRawFuturesTicker, mapPionexToCommon } from '../adapters/pionexAdapter';
import { BinanceRawFuturesTicker, mapBinanceToCommon } from '../adapters/binanceAdapter';
import { SettlementWindowBar, SettlementEventWindow, CommonFundingRecord } from '../types/schema';
import { enrichKlineBar, simulateExecutionExperiment, DEFAULT_CONFIG } from '../engine/arbitrageEngine';

export interface MarketEventDataset {
  symbol: string;
  funding_time: number;
  funding_time_str: string;
  category: 'High Spread (≥0.20%)' | 'Borderline (0.15%-0.20%)' | 'Sub-Threshold (<0.15%)';
  description: string;
  pionex_raw: PionexRawFuturesTicker;
  binance_raw: BinanceRawFuturesTicker;
  pionex_common: CommonFundingRecord;
  binance_common: CommonFundingRecord;
  pionex_klines: SettlementWindowBar[];
  binance_klines: SettlementWindowBar[];
  event_window: SettlementEventWindow;
}

function generate5BarKlines(
  exchange: 'Pionex' | 'Binance',
  symbol: string,
  fundingTime: number,
  basePrice: number,
  baseVol: number,
  volShockMult: number,
  volatilityMult: number
): SettlementWindowBar[] {
  const offsets: { label: SettlementWindowBar['offset_label']; minuteOffset: number }[] = [
    { label: 'T-2m', minuteOffset: -2 },
    { label: 'T-1m', minuteOffset: -1 },
    { label: 'T',    minuteOffset: 0 },
    { label: 'T+1m', minuteOffset: 1 },
    { label: 'T+2m', minuteOffset: 2 },
  ];

  let currentPrice = basePrice;
  const bars: SettlementWindowBar[] = [];

  offsets.forEach(({ label, minuteOffset }) => {
    const klineTime = fundingTime + minuteOffset * 60 * 1000;
    const isSettlementBar = label === 'T';
    const isExitBar = label === 'T+1m';

    const volFactor = isSettlementBar ? volShockMult : isExitBar ? volShockMult * 0.7 : 0.95 + Math.random() * 0.15;
    const barVol = baseVol * volFactor;

    const barVolat = isSettlementBar ? volatilityMult * 2.2 : isExitBar ? volatilityMult * 1.5 : volatilityMult;
    const priceDrift = (Math.random() - 0.48) * (basePrice * barVolat * 0.5);

    const open = currentPrice;
    const close = currentPrice + priceDrift;
    const high = Math.max(open, close) + Math.abs(priceDrift) * 0.4 + basePrice * barVolat * 0.3;
    const low = Math.min(open, close) - Math.abs(priceDrift) * 0.4 - basePrice * barVolat * 0.3;

    currentPrice = close;

    bars.push(
      enrichKlineBar({
        exchange,
        symbol,
        funding_time: fundingTime,
        kline_time: klineTime,
        offset_label: label,
        open,
        high,
        low,
        close,
        volume: barVol,
      }, baseVol)
    );
  });

  return bars;
}

const BASE_EVENTS = [
  {
    symbol: 'PEPEUSDT',
    pionexSymbol: 'PEPE_USDT',
    fundingTime: 1718006400000, // 2024-06-10 08:00:00 UTC
    dateStr: '2024-06-10 08:00 UTC',
    pionexRate: 0.0042, // +0.42% (Meme coin extreme demand on Pionex)
    binanceRate: 0.0006, // +0.06%
    basePrice: 0.00001245,
    baseVol: 2400000,
    volShock: 4.8,
    volatility: 0.0035, // 0.35% range
    category: 'High Spread (≥0.20%)' as const,
    description: 'Meme frenzy: Pionex funding surges to +0.42% while Binance maintains lower leverage demand. Spread = 0.36%.',
  },
  {
    symbol: 'SOLUSDT',
    pionexSymbol: 'SOL_USDT',
    fundingTime: 1718035200000, // 2024-06-10 16:00:00 UTC
    dateStr: '2024-06-10 16:00 UTC',
    pionexRate: 0.0031, // +0.31%
    binanceRate: 0.0008, // +0.08%
    basePrice: 154.20,
    baseVol: 8500000,
    volShock: 3.2,
    volatility: 0.0018, // 0.18% range
    category: 'High Spread (≥0.20%)' as const,
    description: 'SOL ecosystem rally: 0.23% spread creates a viable arbitrage window over the 0.20% fee hurdle.',
  },
  {
    symbol: 'DOGEUSDT',
    pionexSymbol: 'DOGE_USDT',
    fundingTime: 1718064000000, // 2024-06-11 00:00:00 UTC
    dateStr: '2024-06-11 00:00 UTC',
    pionexRate: -0.0028, // -0.28% (Negative funding on Pionex)
    binanceRate: 0.0004, // +0.04%
    basePrice: 0.1425,
    baseVol: 4200000,
    volShock: 3.6,
    volatility: 0.0022,
    category: 'High Spread (≥0.20%)' as const,
    description: 'Inverse funding: Heavy short pressure on Pionex (-0.28%) vs Binance neutral (+0.04%). Spread = 0.32%.',
  },
  {
    symbol: 'SUIUSDT',
    pionexSymbol: 'SUI_USDT',
    fundingTime: 1718092800000, // 2024-06-11 08:00:00 UTC
    dateStr: '2024-06-11 08:00 UTC',
    pionexRate: 0.0029, // +0.29%
    binanceRate: 0.0007, // +0.07%
    basePrice: 1.84,
    baseVol: 3100000,
    volShock: 2.9,
    volatility: 0.0025,
    category: 'High Spread (≥0.20%)' as const,
    description: 'Altcoin rotation: Spread = 0.22%. Exactly tests the 0.20% research threshold margin.',
  },
  {
    symbol: 'BTCUSDT',
    pionexSymbol: 'BTC_USDT',
    fundingTime: 1718121600000, // 2024-06-11 16:00:00 UTC
    dateStr: '2024-06-11 16:00 UTC',
    pionexRate: 0.0019, // +0.19%
    binanceRate: 0.0001, // +0.01%
    basePrice: 67450.0,
    baseVol: 28000000,
    volShock: 2.4,
    volatility: 0.0009, // 0.09% range
    category: 'Borderline (0.15%-0.20%)' as const,
    description: 'BTC funding spread = 0.18%. Borderline opportunity: 0.20% taker fee exceeds gross funding!',
  },
  {
    symbol: 'ETHUSDT',
    pionexSymbol: 'ETH_USDT',
    fundingTime: 1718150400000, // 2024-06-12 00:00:00 UTC
    dateStr: '2024-06-12 00:00 UTC',
    pionexRate: 0.0015, // +0.15%
    binanceRate: 0.0002, // +0.02%
    basePrice: 3520.0,
    baseVol: 16000000,
    volShock: 2.1,
    volatility: 0.0011,
    category: 'Borderline (0.15%-0.20%)' as const,
    description: 'ETH post-ETF event: Spread = 0.13%. Negative realized PnL expected due to 0.20% fixed fee friction.',
  },
  {
    symbol: 'WIFUSDT',
    pionexSymbol: 'WIF_USDT',
    fundingTime: 1718179200000, // 2024-06-12 08:00:00 UTC
    dateStr: '2024-06-12 08:00 UTC',
    pionexRate: 0.0055, // +0.55%
    binanceRate: 0.0012, // +0.12%
    basePrice: 2.75,
    baseVol: 5500000,
    volShock: 5.4, // Large volume shock
    volatility: 0.0042, // High volatility
    category: 'High Spread (≥0.20%)' as const,
    description: 'Extreme volatility meme: Spread = 0.43%, but high ±2m volume shock and wide bid/ask spreads introduce slippage.',
  },
  {
    symbol: 'NEARUSDT',
    pionexSymbol: 'NEAR_USDT',
    fundingTime: 1718208000000, // 2024-06-12 16:00:00 UTC
    dateStr: '2024-06-12 16:00 UTC',
    pionexRate: 0.0009, // +0.09%
    binanceRate: 0.0003, // +0.03%
    basePrice: 6.45,
    baseVol: 2200000,
    volShock: 1.6,
    volatility: 0.0012,
    category: 'Sub-Threshold (<0.15%)' as const,
    description: 'Calm market: Spread = 0.06%. Deeply below research threshold of 0.20%.',
  },
];

export const MOCK_DATASETS: MarketEventDataset[] = BASE_EVENTS.map(item => {
  const pKlines = generate5BarKlines('Pionex', item.symbol, item.fundingTime, item.basePrice, item.baseVol * 0.4, item.volShock, item.volatility);
  const bKlines = generate5BarKlines('Binance', item.symbol, item.fundingTime, item.basePrice, item.baseVol * 0.6, item.volShock * 1.1, item.volatility * 0.9);

  const pionexRaw: PionexRawFuturesTicker = {
    symbol: item.pionexSymbol,
    time: item.fundingTime - 45000,
    fundingRate: item.pionexRate,
    fundingTime: item.fundingTime,
    nextFundingTime: item.fundingTime + 8 * 3600 * 1000,
    markPrice: item.basePrice,
    indexPrice: item.basePrice * 0.9998,
    lastPrice: item.basePrice,
    bid1: item.basePrice * 0.9998,
    ask1: item.basePrice * 1.0002,
    volume24h: item.baseVol * 1440 * 0.4,
    openInterest: item.baseVol * 120,
    kline: {
      open: pKlines[2].open,
      high: pKlines[2].high,
      low: pKlines[2].low,
      close: pKlines[2].close,
      volume: pKlines[2].volume,
    },
  };

  const binanceRaw: BinanceRawFuturesTicker = {
    symbol: item.symbol,
    time: item.fundingTime - 45000,
    lastFundingRate: item.binanceRate,
    nextFundingTime: item.fundingTime,
    markPrice: item.basePrice,
    indexPrice: item.basePrice * 0.9998,
    lastPrice: item.basePrice,
    bidPrice: item.basePrice * 0.9999,
    askPrice: item.basePrice * 1.0001,
    volume: item.baseVol * 1440 * 0.6,
    openInterest: item.baseVol * 180,
    kline: {
      open: bKlines[2].open,
      high: bKlines[2].high,
      low: bKlines[2].low,
      close: bKlines[2].close,
      volume: bKlines[2].volume,
    },
  };

  const pionexCommon = mapPionexToCommon(pionexRaw);
  const binanceCommon = mapBinanceToCommon(binanceRaw);

  const spread = Math.abs(item.pionexRate - item.binanceRate);
  const higherExchange = item.pionexRate >= item.binanceRate ? 'Pionex' : 'Binance';

  const avgVolat = ((pKlines[2].volatility || 0.1) + (bKlines[2].volatility || 0.1)) / 2;

  const eventWindow: SettlementEventWindow = {
    id: `${item.symbol}-${item.fundingTime}`,
    symbol: item.symbol,
    funding_time: item.fundingTime,
    funding_time_str: item.dateStr,
    pionex_rate: item.pionexRate,
    binance_rate: item.binanceRate,
    spread,
    higher_exchange: higherExchange,
    pionex_bars: pKlines,
    binance_bars: bKlines,
    avg_volatility_pct: avgVolat,
    volume_spike_ratio: item.volShock,
    estimated_slippage_pct: (avgVolat * 0.15) / 100,
  };

  return {
    symbol: item.symbol,
    funding_time: item.fundingTime,
    funding_time_str: item.dateStr,
    category: item.category,
    description: item.description,
    pionex_raw: pionexRaw,
    binance_raw: binanceRaw,
    pionex_common: pionexCommon,
    binance_common: binanceCommon,
    pionex_klines: pKlines,
    binance_klines: bKlines,
    event_window: eventWindow,
  };
});

/**
 * Executes backtest simulation on all datasets using the standard experiment
 */
export function runAllBacktests(datasets: MarketEventDataset[] = MOCK_DATASETS) {
  return datasets.map(d =>
    simulateExecutionExperiment(
      d.pionex_common,
      d.binance_common,
      d.pionex_klines,
      d.binance_klines,
      DEFAULT_CONFIG
    )
  );
}
