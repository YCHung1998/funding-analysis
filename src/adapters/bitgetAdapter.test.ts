import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BITGET_FIELD_MAPPING_DOC, mapBitgetToCommon, type BitgetRawFuturesTicker } from './bitgetAdapter';

const NOW = Date.UTC(2026, 0, 1, 7, 30, 0);
const SETTLEMENT = Date.UTC(2026, 0, 1, 8); // 1767254400000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mapBitgetToCommon', () => {
  it('[Q-02] 現況：完整 fixture，結算時間以 8 小時邊界推算', () => {
    // 修正後預期：結算時間與週期來自交易所回傳，不得以 8h 邊界推算（Invariant 4）
    const raw: BitgetRawFuturesTicker = {
      symbol: 'BTCUSDT',
      lastPr: '100000',
      askPr: '100000.1',
      bidPr: '99999.9',
      high24h: '101000',
      low24h: '98000',
      ts: '1767252600000',
      baseVolume: '25000',
      quoteVolume: '2400000000',
      usdtVolume: '2500000000',
      openUtc: '99000',
      indexPrice: '100001',
      fundingRate: '0.000194',
      holdingAmount: '10',
      markPrice: '100',
      kline: { open: 100000, high: 100050, low: 99950, close: 100010, volume: 1200 },
    };
    expect(mapBitgetToCommon(raw)).toEqual({
      exchange: 'Bitget',
      symbol: 'BTCUSDT',
      event_time: 1767252600000,
      funding_time: SETTLEMENT,
      funding_rate: 0.000194,
      next_funding_time: 1767283200000,
      mark_price: 100,
      index_price: 100001,
      last_price: 100000,
      bid_price: 99999.9,
      ask_price: 100000.1,
      volume: 2500000000,
      open_interest: 1000,
      kline_open: 100000,
      kline_high: 100050,
      kline_low: 99950,
      kline_close: 100010,
      kline_volume: 1200,
      fee_rate: 0.0006,
      native_symbol: 'BTCUSDT',
      native_field_mapping: BITGET_FIELD_MAPPING_DOC,
    });
  });

  it('缺欄位 fixture：使用固定系統時間與預設值', () => {
    const raw = {
      symbol: 'ETHUSDT',
      lastPr: '50',
      askPr: '',
      bidPr: '',
      ts: '',
      quoteVolume: '1234',
      usdtVolume: '',
      indexPrice: '',
      fundingRate: '',
      holdingAmount: '',
      markPrice: '',
    } as BitgetRawFuturesTicker;
    expect(mapBitgetToCommon(raw)).toEqual({
      exchange: 'Bitget',
      symbol: 'ETHUSDT',
      event_time: NOW,
      funding_time: SETTLEMENT,
      funding_rate: 0,
      next_funding_time: SETTLEMENT + 8 * 3600 * 1000,
      mark_price: 50,
      index_price: 50,
      last_price: 50,
      bid_price: 50 * 0.9999,
      ask_price: 50 * 1.0001,
      volume: 1234,
      open_interest: 0,
      kline_open: 50,
      kline_high: 50 * 1.0005,
      kline_low: 50 * 0.9995,
      kline_close: 50,
      kline_volume: 450000,
      fee_rate: 0.0006,
      native_symbol: 'ETHUSDT',
      native_field_mapping: BITGET_FIELD_MAPPING_DOC,
    });
  });
});
