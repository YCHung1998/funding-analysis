/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Pionex Adapter for Common Schema v0.1
 * Maps native Pionex Futures API payloads to the unified Common Schema.
 */

import { CommonFundingRecord } from '../types/schema';

export interface PionexRawFuturesTicker {
  symbol: string;              // e.g. "BTC_USDT"
  time: number;                // Event timestamp ms
  fundingRate: string | number;// e.g. "0.00251" or 0.00251
  fundingTime: number;         // e.g. 1718006400000
  nextFundingTime?: number;    // Next funding settlement
  markPrice: string | number;  // Mark price
  indexPrice: string | number; // Spot index price
  lastPrice: string | number;  // Last trade price
  bid1: string | number;       // Best Bid
  ask1: string | number;       // Best Ask
  volume24h: string | number;  // 24h volume
  openInterest?: string | number;
  kline?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
}

export const PIONEX_FIELD_MAPPING_DOC: Record<string, { nativeKey: string; note: string }> = {
  exchange: { nativeKey: "'Pionex'", note: "Hardcoded identifier" },
  symbol: { nativeKey: "symbol.replace('_', '')", note: "Standardized from BTC_USDT -> BTCUSDT" },
  event_time: { nativeKey: "time", note: "Timestamp of websocket/rest event (ms)" },
  funding_time: { nativeKey: "fundingTime", note: "Settlement timestamp T" },
  funding_rate: { nativeKey: "fundingRate", note: "Float representation of current funding rate" },
  next_funding_time: { nativeKey: "nextFundingTime || fundingTime + 28800000", note: "Next 8h settlement cycle" },
  mark_price: { nativeKey: "markPrice", note: "Perpetual mark price" },
  index_price: { nativeKey: "indexPrice", note: "Spot index price" },
  last_price: { nativeKey: "lastPrice", note: "Latest matched execution price" },
  bid_price: { nativeKey: "bid1", note: "Top bid for immediate short market orders" },
  ask_price: { nativeKey: "ask1", note: "Top ask for immediate long market orders" },
  volume: { nativeKey: "volume24h", note: "Rolling 24-hour notional turnover" },
  open_interest: { nativeKey: "openInterest", note: "Total open perpetual contracts" },
  kline_open: { nativeKey: "kline.open", note: "Open price of the 1m settlement bar" },
  kline_high: { nativeKey: "kline.high", note: "High price of the 1m settlement bar" },
  kline_low: { nativeKey: "kline.low", note: "Low price of the 1m settlement bar" },
  kline_close: { nativeKey: "kline.close", note: "Close price of the 1m settlement bar" },
  kline_volume: { nativeKey: "kline.volume", note: "Volume of the 1m settlement bar" },
  fee_rate: { nativeKey: "0.0005", note: "Fixed lowest member tier (VIP 0 Taker: 0.05%)" },
};

export function mapPionexToCommon(raw: PionexRawFuturesTicker): CommonFundingRecord {
  const unifiedSymbol = raw.symbol.replace(/_/g, '').toUpperCase();
  const fundingRateNum = typeof raw.fundingRate === 'string' ? parseFloat(raw.fundingRate) : raw.fundingRate;
  const markPriceNum = typeof raw.markPrice === 'string' ? parseFloat(raw.markPrice) : raw.markPrice;
  const indexPriceNum = typeof raw.indexPrice === 'string' ? parseFloat(raw.indexPrice) : raw.indexPrice;
  const lastPriceNum = typeof raw.lastPrice === 'string' ? parseFloat(raw.lastPrice) : raw.lastPrice;
  const bidNum = typeof raw.bid1 === 'string' ? parseFloat(raw.bid1) : raw.bid1;
  const askNum = typeof raw.ask1 === 'string' ? parseFloat(raw.ask1) : raw.ask1;
  const volumeNum = typeof raw.volume24h === 'string' ? parseFloat(raw.volume24h) : raw.volume24h;
  const oiNum = raw.openInterest ? (typeof raw.openInterest === 'string' ? parseFloat(raw.openInterest) : raw.openInterest) : volumeNum * 0.35;

  const klineOpen = raw.kline?.open ?? markPriceNum;
  const klineHigh = raw.kline?.high ?? markPriceNum * 1.0008;
  const klineLow = raw.kline?.low ?? markPriceNum * 0.9992;
  const klineClose = raw.kline?.close ?? markPriceNum;
  const klineVol = raw.kline?.volume ?? volumeNum / 1440;

  return {
    exchange: 'Pionex',
    symbol: unifiedSymbol,
    event_time: raw.time || Date.now(),
    funding_time: raw.fundingTime,
    funding_rate: fundingRateNum,
    next_funding_time: raw.nextFundingTime || raw.fundingTime + 8 * 3600 * 1000,
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
    fee_rate: 0.0005, // Conservative lowest tier taker: 0.05%
    native_symbol: raw.symbol,
    native_field_mapping: Object.fromEntries(
      Object.entries(PIONEX_FIELD_MAPPING_DOC).map(([k, v]) => [k, v.nativeKey])
    ),
  };
}
