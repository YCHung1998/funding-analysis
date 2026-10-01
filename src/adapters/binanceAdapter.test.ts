import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BINANCE_FIELD_MAPPING_DOC, mapBinanceToCommon, type BinanceRawFuturesTicker } from './binanceAdapter';

const NOW = Date.UTC(2026, 0, 1, 7, 30, 0);
const SETTLEMENT = Date.UTC(2026, 0, 1, 8); // 1767254400000
const nativeMapping = Object.fromEntries(Object.entries(BINANCE_FIELD_MAPPING_DOC).map(([k, v]) => [k, v.nativeKey]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mapBinanceToCommon', () => {
  it('[Q-02] 現況：完整 fixture，下次結算假設 8 小時', () => {
    // 修正後預期：next_funding_time 來自交易所 fundingInfo 週期，不得以「+ 8h」推算（Invariant 4）
    const raw: BinanceRawFuturesTicker = {
      symbol: 'BTCUSDT',
      time: 1767252000000,
      lastFundingRate: '0.00010000',
      nextFundingTime: SETTLEMENT,
      markPrice: '100000.5',
      indexPrice: '100001',
      lastPrice: '100000',
      bidPrice: '99999.9',
      askPrice: '100000.1',
      volume: '1500000000',
      openInterest: '600000000',
      kline: { open: 100000, high: 100050, low: 99950, close: 100010, volume: 1200 },
    };
    expect(mapBinanceToCommon(raw)).toEqual({
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      event_time: 1767252000000,
      funding_time: 1767254400000,
      funding_rate: 0.0001,
      next_funding_time: 1767283200000,
      mark_price: 100000.5,
      index_price: 100001,
      last_price: 100000,
      bid_price: 99999.9,
      ask_price: 100000.1,
      volume: 1500000000,
      open_interest: 600000000,
      kline_open: 100000,
      kline_high: 100050,
      kline_low: 99950,
      kline_close: 100010,
      kline_volume: 1200,
      fee_rate: 0.0005,
      native_symbol: 'BTCUSDT',
      native_field_mapping: nativeMapping,
    });
    expect(nativeMapping.next_funding_time).toBe('nextFundingTime + 28800000');
  });

  it('缺欄位 fixture：使用固定系統時間與預設值', () => {
    const raw = {
      symbol: 'ethusdt',
      lastFundingRate: -0.0002,
      nextFundingTime: SETTLEMENT,
      markPrice: 3000,
      indexPrice: 3001,
      bidPrice: 2999.5,
      askPrice: 3000.5,
    } as BinanceRawFuturesTicker;
    expect(mapBinanceToCommon(raw)).toEqual({
      exchange: 'Binance',
      symbol: 'ETHUSDT',
      event_time: NOW,
      funding_time: SETTLEMENT,
      funding_rate: -0.0002,
      next_funding_time: SETTLEMENT + 8 * 3600 * 1000,
      mark_price: 3000,
      index_price: 3001,
      last_price: 3000,
      bid_price: 2999.5,
      ask_price: 3000.5,
      volume: 500000000,
      open_interest: 500000000 * 0.4,
      kline_open: 3000,
      kline_high: 3000 * 1.0007,
      kline_low: 3000 * 0.9993,
      kline_close: 3000,
      kline_volume: 500000000 / 1440,
      fee_rate: 0.0005,
      native_symbol: 'ethusdt',
      native_field_mapping: nativeMapping,
    });
  });
});
