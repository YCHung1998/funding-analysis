import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BYBIT_FIELD_MAPPING_DOC, mapBybitToCommon, type BybitRawLinearTicker } from './bybitAdapter';

const NOW = Date.UTC(2026, 0, 1, 7, 30, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mapBybitToCommon', () => {
  it('完整 fixture：使用回傳的結算週期', () => {
    const raw: BybitRawLinearTicker = {
      symbol: 'BTCUSDT',
      lastPrice: '100000',
      indexPrice: '100001',
      markPrice: '100000.5',
      prevPrice24h: '99000',
      price24hPcnt: '0.01',
      highPrice24h: '101000',
      lowPrice24h: '98000',
      openInterest: '5000',
      openInterestValue: '500000000',
      turnover24h: '2000000000',
      volume24h: '20000',
      fundingRate: '0.0001',
      nextFundingTime: '1767254400000',
      fundingIntervalHour: '4',
      bid1Price: '99999.9',
      ask1Price: '100000.1',
      time: 1767252000000,
      kline: { open: 100000, high: 100050, low: 99950, close: 100010, volume: 1200 },
    };
    expect(mapBybitToCommon(raw)).toEqual({
      exchange: 'Bybit',
      symbol: 'BTCUSDT',
      event_time: 1767252000000,
      funding_time: 1767254400000,
      funding_rate: 0.0001,
      next_funding_time: 1767268800000,
      mark_price: 100000.5,
      index_price: 100001,
      last_price: 100000,
      bid_price: 99999.9,
      ask_price: 100000.1,
      volume: 2000000000,
      open_interest: 500000000,
      kline_open: 100000,
      kline_high: 100050,
      kline_low: 99950,
      kline_close: 100010,
      kline_volume: 1200,
      fee_rate: 0.00055,
      native_symbol: 'BTCUSDT',
      native_field_mapping: BYBIT_FIELD_MAPPING_DOC,
    });
  });

  it('[Q-02] 現況：缺欄位 fixture，結算時間與週期假設 8 小時', () => {
    // 修正後預期：缺結算時間 / 週期時標示 STALE 或淘汰，不得假設 8h（Invariant 4）
    const raw = {
      symbol: 'ETHUSDT',
      lastPrice: '',
      indexPrice: '',
      markPrice: '0.5',
      openInterestValue: '',
      turnover24h: '',
      fundingRate: '',
      nextFundingTime: '',
      fundingIntervalHour: '',
      bid1Price: '',
      ask1Price: '',
    } as BybitRawLinearTicker;
    expect(mapBybitToCommon(raw)).toEqual({
      exchange: 'Bybit',
      symbol: 'ETHUSDT',
      event_time: NOW,
      funding_time: NOW + 8 * 3600 * 1000,
      funding_rate: 0,
      next_funding_time: NOW + 16 * 3600 * 1000,
      mark_price: 0.5,
      index_price: 0.5,
      last_price: 0.5,
      bid_price: 0.5 * 0.9999,
      ask_price: 0.5 * 1.0001,
      volume: 0,
      open_interest: 0,
      kline_open: 0.5,
      kline_high: 0.5 * 1.0005,
      kline_low: 0.5 * 0.9995,
      kline_close: 0.5,
      kline_volume: 500000,
      fee_rate: 0.00055,
      native_symbol: 'ETHUSDT',
      native_field_mapping: BYBIT_FIELD_MAPPING_DOC,
    });
  });
});
