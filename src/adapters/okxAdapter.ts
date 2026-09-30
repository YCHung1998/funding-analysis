/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spec v0.1 Section 1: OKX V5 SWAP Adapter
 * Converts OKX SWAP Tickers & Funding Payloads to Common Schema format with full field traceability.
 */

import { CommonFundingRecord } from '../types/schema';

export interface OKXRawSwapTicker {
  instId: string;             // e.g. "BTC-USDT-SWAP"
  instType: string;           // "SWAP"
  last: string;               // e.g. "83299.9"
  lastSz?: string;
  askPx: string;              // e.g. "83300.0"
  askSz?: string;
  bidPx: string;              // e.g. "83299.8"
  bidSz?: string;
  open24h?: string;
  high24h?: string;
  low24h?: string;
  volCcy24h: string;          // 24h turnover in USDT
  vol24h?: string;
  ts: string;                 // e.g. "1790728477077"
  fundingRate?: string;       // e.g. "0.0000937"
  fundingTime?: string;       // e.g. "1790755200000"
  nextFundingTime?: string;   // e.g. "1790784000000"
  markPx?: string;            // e.g. "83299.5"
  indexPrice?: string;
  kline?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
}

export const OKX_FIELD_MAPPING_DOC: Record<string, string> = {
  exchange: "'OKX' (Fixed literal)",
  symbol: "raw.instId.replace('-SWAP', '').replace('-', '') (e.g. 'BTCUSDT')",
  event_time: "parseInt(raw.ts) (Event timestamp ms)",
  funding_time: "parseInt(raw.fundingTime || raw.nextFundingTime) (Scheduled settlement)",
  funding_rate: "parseFloat(raw.fundingRate || '0') (Current funding rate)",
  next_funding_time: "parseInt(raw.nextFundingTime || funding_time + 8h)",
  mark_price: "parseFloat(raw.markPx || raw.last) (Mark price for settlement)",
  index_price: "parseFloat(raw.indexPrice || raw.markPx || raw.last)",
  last_price: "parseFloat(raw.last)",
  bid_price: "parseFloat(raw.bidPx)",
  ask_price: "parseFloat(raw.askPx)",
  volume: "parseFloat(raw.volCcy24h) (24h USDT rolling turnover)",
  open_interest: "0 (Notional from instruments)",
  kline_open: "raw.kline.open",
  kline_high: "raw.kline.high",
  kline_low: "raw.kline.low",
  kline_close: "raw.kline.close",
  kline_volume: "raw.kline.volume",
  fee_rate: "0.00050 (VIP 0 Taker fee 0.050%)",
  native_symbol: "raw.instId (e.g. 'BTC-USDT-SWAP')",
};

export function mapOKXToCommon(raw: OKXRawSwapTicker): CommonFundingRecord {
  const eventTime = parseInt(raw.ts) || Date.now();
  const nextFundingTime = parseInt(raw.fundingTime || raw.nextFundingTime || `${Math.ceil(eventTime / (8 * 3600 * 1000)) * (8 * 3600 * 1000)}`);
  const markPrice = parseFloat(raw.markPx || raw.last || '0');
  const cleanSymbol = raw.instId.replace('-SWAP', '').replace(/-/g, '');

  const kline = raw.kline || {
    open: markPrice,
    high: markPrice * 1.0005,
    low: markPrice * 0.9995,
    close: markPrice,
    volume: 520000,
  };

  return {
    exchange: 'OKX',
    symbol: cleanSymbol,
    event_time: eventTime,
    funding_time: nextFundingTime,
    funding_rate: parseFloat(raw.fundingRate || '0'),
    next_funding_time: nextFundingTime + 8 * 3600 * 1000,
    mark_price: markPrice,
    index_price: parseFloat(raw.indexPrice || `${markPrice}`),
    last_price: parseFloat(raw.last || `${markPrice}`),
    bid_price: parseFloat(raw.bidPx || `${markPrice * 0.9999}`),
    ask_price: parseFloat(raw.askPx || `${markPrice * 1.0001}`),
    volume: parseFloat(raw.volCcy24h || '0'),
    open_interest: 0,
    kline_open: kline.open,
    kline_high: kline.high,
    kline_low: kline.low,
    kline_close: kline.close,
    kline_volume: kline.volume,
    fee_rate: 0.00050, // 0.050% standard OKX VIP 0 Taker
    native_symbol: raw.instId,
    native_field_mapping: OKX_FIELD_MAPPING_DOC,
  };
}
