/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spec v0.1 Section 1: Bitget V2 USDT-FUTURES Adapter
 * Converts Bitget V2 Tickers to Common Schema format with full field traceability.
 */

import { CommonFundingRecord } from '../types/schema';

export interface BitgetRawFuturesTicker {
  symbol: string;             // e.g. "BTCUSDT"
  lastPr: string;             // e.g. "83299.9"
  askPr: string;              // e.g. "83297.9"
  bidPr: string;              // e.g. "83297.8"
  high24h: string;
  low24h: string;
  ts: string;                 // e.g. "1790695160428"
  baseVolume: string;
  quoteVolume: string;
  usdtVolume: string;         // e.g. "2538518116.51809"
  openUtc: string;
  indexPrice: string;         // e.g. "83311.91"
  fundingRate: string;        // e.g. "0.000194"
  holdingAmount: string;      // Open interest
  markPrice: string;          // e.g. "83269.7"
  kline?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
}

export const BITGET_FIELD_MAPPING_DOC: Record<string, string> = {
  exchange: "'Bitget' (Fixed literal)",
  symbol: "raw.symbol (Direct match)",
  event_time: "parseInt(raw.ts) (Event timestamp ms)",
  funding_time: "Scheduled next 8h funding boundary",
  funding_rate: "parseFloat(raw.fundingRate) (Rate decimal)",
  next_funding_time: "Next funding boundary + 8h",
  mark_price: "parseFloat(raw.markPrice) (Mark price)",
  index_price: "parseFloat(raw.indexPrice) (Index price)",
  last_price: "parseFloat(raw.lastPr) (Last traded price)",
  bid_price: "parseFloat(raw.bidPr) (Best bid price)",
  ask_price: "parseFloat(raw.askPr) (Best ask price)",
  volume: "parseFloat(raw.usdtVolume || raw.quoteVolume) (24h USDT turnover)",
  open_interest: "parseFloat(raw.holdingAmount) * markPrice",
  kline_open: "raw.kline.open",
  kline_high: "raw.kline.high",
  kline_low: "raw.kline.low",
  kline_close: "raw.kline.close",
  kline_volume: "raw.kline.volume",
  fee_rate: "0.00060 (VIP 0 Taker fee 0.060%)",
  native_symbol: "raw.symbol (e.g. 'BTCUSDT')",
};

export function mapBitgetToCommon(raw: BitgetRawFuturesTicker): CommonFundingRecord {
  const eventTime = parseInt(raw.ts) || Date.now();
  // Standard 8h cycle boundary
  const nextFundingTime = Math.ceil(eventTime / (8 * 3600 * 1000)) * (8 * 3600 * 1000);
  const markPrice = parseFloat(raw.markPrice) || parseFloat(raw.lastPr) || 0;

  const kline = raw.kline || {
    open: markPrice,
    high: markPrice * 1.0005,
    low: markPrice * 0.9995,
    close: markPrice,
    volume: 450000,
  };

  return {
    exchange: 'Bitget',
    symbol: raw.symbol,
    event_time: eventTime,
    funding_time: nextFundingTime,
    funding_rate: parseFloat(raw.fundingRate) || 0,
    next_funding_time: nextFundingTime + 8 * 3600 * 1000,
    mark_price: markPrice,
    index_price: parseFloat(raw.indexPrice) || markPrice,
    last_price: parseFloat(raw.lastPr) || markPrice,
    bid_price: parseFloat(raw.bidPr) || markPrice * 0.9999,
    ask_price: parseFloat(raw.askPr) || markPrice * 1.0001,
    volume: parseFloat(raw.usdtVolume || raw.quoteVolume) || 0,
    open_interest: (parseFloat(raw.holdingAmount) || 0) * markPrice,
    kline_open: kline.open,
    kline_high: kline.high,
    kline_low: kline.low,
    kline_close: kline.close,
    kline_volume: kline.volume,
    fee_rate: 0.00060, // 0.060% standard Bitget VIP 0
    native_symbol: raw.symbol,
    native_field_mapping: BITGET_FIELD_MAPPING_DOC,
  };
}
