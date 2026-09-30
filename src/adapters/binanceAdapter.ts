/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Binance Adapter for Common Schema v0.1
 * Maps native Binance USD-M Futures API payloads to the unified Common Schema.
 */

import { CommonFundingRecord } from '../types/schema';

export interface BinanceRawFuturesTicker {
  symbol: string;              // e.g. "BTCUSDT"
  time: number;                // Event timestamp ms
  lastFundingRate: string | number; // e.g. "0.00010000"
  nextFundingTime: number;     // e.g. 1718006400000
  markPrice: string | number;  // Mark price
  indexPrice: string | number; // Spot index price
  lastPrice?: string | number; // Executed trade price
  bidPrice: string | number;   // Best Bid
  askPrice: string | number;   // Best Ask
  volume?: string | number;    // 24h volume
  openInterest?: string | number;
  kline?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
}

export const BINANCE_FIELD_MAPPING_DOC: Record<string, { nativeKey: string; note: string }> = {
  exchange: { nativeKey: "'Binance'", note: "Hardcoded identifier" },
  symbol: { nativeKey: "symbol", note: "Native Binance symbol e.g. BTCUSDT" },
  event_time: { nativeKey: "time", note: "Event timestamp from API (ms)" },
  funding_time: { nativeKey: "nextFundingTime", note: "Binance uses nextFundingTime for upcoming settlement T" },
  funding_rate: { nativeKey: "lastFundingRate", note: "Current applied funding rate" },
  next_funding_time: { nativeKey: "nextFundingTime + 28800000", note: "Subsequent 8h funding cycle" },
  mark_price: { nativeKey: "markPrice", note: "Binance mark price" },
  index_price: { nativeKey: "indexPrice", note: "Binance composite spot index price" },
  last_price: { nativeKey: "lastPrice || markPrice", note: "Latest ticker lastPrice or mark fallback" },
  bid_price: { nativeKey: "bidPrice", note: "Best bid from bookTicker" },
  ask_price: { nativeKey: "askPrice", note: "Best ask from bookTicker" },
  volume: { nativeKey: "volume", note: "24h notional quote volume" },
  open_interest: { nativeKey: "openInterest", note: "Binance open interest notional" },
  kline_open: { nativeKey: "kline.open", note: "Binance 1m kline open" },
  kline_high: { nativeKey: "kline.high", note: "Binance 1m kline high" },
  kline_low: { nativeKey: "kline.low", note: "Binance 1m kline low" },
  kline_close: { nativeKey: "kline.close", note: "Binance 1m kline close" },
  kline_volume: { nativeKey: "kline.volume", note: "Binance 1m kline volume" },
  fee_rate: { nativeKey: "0.0005", note: "Regular VIP 0 Taker fee: 0.050%" },
};

export function mapBinanceToCommon(raw: BinanceRawFuturesTicker): CommonFundingRecord {
  const fundingRateNum = typeof raw.lastFundingRate === 'string' ? parseFloat(raw.lastFundingRate) : raw.lastFundingRate;
  const markPriceNum = typeof raw.markPrice === 'string' ? parseFloat(raw.markPrice) : raw.markPrice;
  const indexPriceNum = typeof raw.indexPrice === 'string' ? parseFloat(raw.indexPrice) : raw.indexPrice;
  const lastPriceNum = raw.lastPrice ? (typeof raw.lastPrice === 'string' ? parseFloat(raw.lastPrice) : raw.lastPrice) : markPriceNum;
  const bidNum = typeof raw.bidPrice === 'string' ? parseFloat(raw.bidPrice) : raw.bidPrice;
  const askNum = typeof raw.askPrice === 'string' ? parseFloat(raw.askPrice) : raw.askPrice;
  const volumeNum = raw.volume ? (typeof raw.volume === 'string' ? parseFloat(raw.volume) : raw.volume) : 500000000;
  const oiNum = raw.openInterest ? (typeof raw.openInterest === 'string' ? parseFloat(raw.openInterest) : raw.openInterest) : volumeNum * 0.4;

  const klineOpen = raw.kline?.open ?? markPriceNum;
  const klineHigh = raw.kline?.high ?? markPriceNum * 1.0007;
  const klineLow = raw.kline?.low ?? markPriceNum * 0.9993;
  const klineClose = raw.kline?.close ?? markPriceNum;
  const klineVol = raw.kline?.volume ?? volumeNum / 1440;

  return {
    exchange: 'Binance',
    symbol: raw.symbol.toUpperCase(),
    event_time: raw.time || Date.now(),
    funding_time: raw.nextFundingTime,
    funding_rate: fundingRateNum,
    next_funding_time: raw.nextFundingTime + 8 * 3600 * 1000,
    mark_price: markPriceNum,
    index_price: indexPriceNum,
    last_price: lastPriceNum,
    bid_price: bidNum,
    ask_price: askNum,
    volume: volumeNum,
    open_interest: oiNum,
    kline_open: klineOpen,
    kline_high: klineHigh,
    kline_low: klineLow,
    kline_close: klineClose,
    kline_volume: klineVol,
    fee_rate: 0.0005, // Binance VIP 0 taker: 0.05%
    native_symbol: raw.symbol,
    native_field_mapping: Object.fromEntries(
      Object.entries(BINANCE_FIELD_MAPPING_DOC).map(([k, v]) => [k, v.nativeKey])
    ),
  };
}
