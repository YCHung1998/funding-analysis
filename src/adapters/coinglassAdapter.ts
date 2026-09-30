/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * CoinGlass Adapter (Spec Layer: Market Intelligence Layer)
 * 
 * ARCHITECTURAL INVARIANT:
 * CoinGlass serves strictly as a Market Intelligence Layer (aggregation, cross-market scanning),
 * NEVER as an execution / exchange truth source. Order placement and balance confirmations
 * must exclusively query primary exchange truth APIs (Pionex, Binance, Bitget).
 */

import { CommonFundingRecord } from '../types/schema';

export interface CoinGlassRawFundingItem {
  symbol: string;              // e.g. "BTC"
  uMarginList: Array<{
    exchangeName: string;      // e.g. "Binance", "Pionex", "Bybit", "OKX"
    rate: number;              // e.g. 0.0001
    nextFundingTime: number;   // Timestamp ms
    predictedRate?: number;
  }>;
}

export interface MarketIntelligenceComparison {
  symbol: string;
  source: 'CoinGlass Intelligence';
  pionex_rate: number;
  binance_rate: number;
  bybit_rate?: number;
  okx_rate?: number;
  market_wide_spread: number;
  best_arbitrage_pair: {
    long_exchange: string;
    short_exchange: string;
    spread: number;
  };
  last_updated: number;
}

export function parseCoinGlassIntelligence(item: CoinGlassRawFundingItem): MarketIntelligenceComparison {
  const pionex = item.uMarginList.find(e => e.exchangeName.toLowerCase().includes('pionex'))?.rate ?? 0.0001;
  const binance = item.uMarginList.find(e => e.exchangeName.toLowerCase().includes('binance'))?.rate ?? 0.0001;
  const bybit = item.uMarginList.find(e => e.exchangeName.toLowerCase().includes('bybit'))?.rate;
  const okx = item.uMarginList.find(e => e.exchangeName.toLowerCase().includes('okx'))?.rate;

  const spread = Math.abs(pionex - binance);
  const longExchange = pionex > binance ? 'Binance' : 'Pionex';
  const shortExchange = pionex > binance ? 'Pionex' : 'Binance';

  return {
    symbol: `${item.symbol}USDT`,
    source: 'CoinGlass Intelligence',
    pionex_rate: pionex,
    binance_rate: binance,
    bybit_rate: bybit,
    okx_rate: okx,
    market_wide_spread: spread,
    best_arbitrage_pair: {
      long_exchange: longExchange,
      short_exchange: shortExchange,
      spread,
    },
    last_updated: Date.now(),
  };
}
