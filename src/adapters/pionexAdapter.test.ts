import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIONEX_FIELD_MAPPING_DOC, mapPionexToCommon, type PionexRawFuturesTicker } from './pionexAdapter';

const NOW = Date.UTC(2026, 0, 1, 7, 30, 0);
const SETTLEMENT = Date.UTC(2026, 0, 1, 8); // 1767254400000
const nativeMapping = Object.fromEntries(Object.entries(PIONEX_FIELD_MAPPING_DOC).map(([k, v]) => [k, v.nativeKey]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mapPionexToCommon', () => {
  it('完整 fixture：使用回傳的 nextFundingTime', () => {
    const raw: PionexRawFuturesTicker = {
      symbol: 'BTC_USDT',
      time: 1767252000000,
      fundingRate: '0.00251',
      fundingTime: SETTLEMENT,
      nextFundingTime: 1767268800000,
      markPrice: '100000.5',
      indexPrice: '100001',
      lastPrice: '100000',
      bid1: '99999.9',
      ask1: '100000.1',
      volume24h: '800000000',
      openInterest: '300000000',
      kline: { open: 100000, high: 100050, low: 99950, close: 100010, volume: 1200 },
    };
    expect(mapPionexToCommon(raw)).toEqual({
      exchange: 'Pionex',
      symbol: 'BTCUSDT',
      event_time: 1767252000000,
      funding_time: SETTLEMENT,
      funding_rate: 0.00251,
      next_funding_time: 1767268800000,
      mark_price: 100000.5,
      index_price: 100001,
      last_price: 100000,
      bid_price: 99999.9,
      ask_price: 100000.1,
      volume: 800000000,
      open_interest: 300000000,
      kline_open: 100000,
      kline_high: 100050,
      kline_low: 99950,
      kline_close: 100010,
      kline_volume: 1200,
      fee_rate: 0.0005,
      native_symbol: 'BTC_USDT',
      native_field_mapping: nativeMapping,
    });
  });

  it('[Q-02] 現況：缺欄位 fixture，缺 nextFundingTime 時假設 8 小時', () => {
    // 修正後預期：缺下次結算時間時標示 STALE，不得以「+ 8h」推算（Invariant 4）
    const raw = {
      symbol: 'eth_usdt',
      time: 0,
      fundingRate: -0.0003,
      fundingTime: SETTLEMENT,
      markPrice: 3000,
      indexPrice: 3001,
      lastPrice: 2999,
      bid1: 2999.5,
      ask1: 3000.5,
      volume24h: 1440000,
    } as PionexRawFuturesTicker;
    expect(mapPionexToCommon(raw)).toEqual({
      exchange: 'Pionex',
      symbol: 'ETHUSDT',
      event_time: NOW,
      funding_time: SETTLEMENT,
      funding_rate: -0.0003,
      next_funding_time: SETTLEMENT + 8 * 3600 * 1000,
      mark_price: 3000,
      index_price: 3001,
      last_price: 2999,
      bid_price: 2999.5,
      ask_price: 3000.5,
      volume: 1440000,
      open_interest: 1440000 * 0.35,
      kline_open: 3000,
      kline_high: 3000 * 1.0008,
      kline_low: 3000 * 0.9992,
      kline_close: 3000,
      kline_volume: 1000,
      fee_rate: 0.0005,
      native_symbol: 'eth_usdt',
      native_field_mapping: nativeMapping,
    });
  });
});
