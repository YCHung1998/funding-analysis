/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spec v0.1 Section 1: Bybit V5 Linear Adapter
 * Converts Bybit Linear Tickers to Common Schema format with full field traceability.
 */

import { CommonFundingRecord } from '../types/schema';

export interface BybitRawLinearTicker {
  symbol: string;             // e.g. "BTCUSDT"
  lastPrice: string;          // e.g. "83262.20"
  indexPrice: string;         // e.g. "83311.91"
  markPrice: string;          // e.g. "83269.70"
  prevPrice24h: string;
  price24hPcnt: string;
  highPrice24h: string;
  lowPrice24h: string;
  openInterest: string;
  openInterestValue: string;
  turnover24h: string;        // USDT volume
  volume24h: string;          // Coin volume
  fundingRate: string;        // e.g. "0.0001"
  nextFundingTime: string;    // e.g. "1790697600000"
  fundingIntervalHour: string;// e.g. "8"
  bid1Price: string;
  ask1Price: string;
  time?: number;
  kline?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
}

export const BYBIT_FIELD_MAPPING_DOC: Record<string, string> = {
  exchange: "'Bybit' (Fixed literal)",
  symbol: "raw.symbol (Direct match)",
  event_time: "raw.time || Date.now() (API response timestamp)",
  funding_time: "parseInt(raw.nextFundingTime) (Scheduled settlement)",
  funding_rate: "parseFloat(raw.fundingRate) (Current funding rate)",
  next_funding_time: "parseInt(raw.nextFundingTime) + (interval * 3600000)",
  mark_price: "parseFloat(raw.markPrice) (Mark price for funding)",
  index_price: "parseFloat(raw.indexPrice) (Spot index reference)",
  last_price: "parseFloat(raw.lastPrice) (Last match price)",
  bid_price: "parseFloat(raw.bid1Price) (Best bid)",
  ask_price: "parseFloat(raw.ask1Price) (Best ask)",
  volume: "parseFloat(raw.turnover24h) (24h USDT rolling volume)",
  open_interest: "parseFloat(raw.openInterestValue) (Open interest USD)",
  kline_open: "raw.kline.open",
  kline_high: "raw.kline.high",
  kline_low: "raw.kline.low",
  kline_close: "raw.kline.close",
  kline_volume: "raw.kline.volume",
  fee_rate: "0.00055 (VIP 0 Taker fee 0.055%)",
  native_symbol: "raw.symbol (e.g. 'BTCUSDT')",
};

export function mapBybitToCommon(raw: BybitRawLinearTicker): CommonFundingRecord {
  const eventTime = raw.time || Date.now();
  const nextFundingTime = parseInt(raw.nextFundingTime) || eventTime + 8 * 3600 * 1000;
  const intervalHours = parseInt(raw.fundingIntervalHour || '8') || 8;

  const markPrice = parseFloat(raw.markPrice) || 0;
  const kline = raw.kline || {
    open: markPrice,
    high: markPrice * 1.0005,
    low: markPrice * 0.9995,
    close: markPrice,
    volume: 500000,
  };

  return {
    exchange: 'Bybit',
    symbol: raw.symbol,
    event_time: eventTime,
    funding_time: nextFundingTime,
    funding_rate: parseFloat(raw.fundingRate) || 0,
    next_funding_time: nextFundingTime + intervalHours * 3600 * 1000,
    mark_price: markPrice,
    index_price: parseFloat(raw.indexPrice) || markPrice,
    last_price: parseFloat(raw.lastPrice) || markPrice,
    bid_price: parseFloat(raw.bid1Price) || markPrice * 0.9999,
    ask_price: parseFloat(raw.ask1Price) || markPrice * 1.0001,
    volume: parseFloat(raw.turnover24h) || 0,
    open_interest: parseFloat(raw.openInterestValue) || 0,
    kline_open: kline.open,
    kline_high: kline.high,
    kline_low: kline.low,
    kline_close: kline.close,
    kline_volume: kline.volume,
    fee_rate: 0.00055, // 0.055% standard Bybit VIP 0
    native_symbol: raw.symbol,
    native_field_mapping: BYBIT_FIELD_MAPPING_DOC,
  };
}
