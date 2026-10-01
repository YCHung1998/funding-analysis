import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OKX_FIELD_MAPPING_DOC, mapOKXToCommon, type OKXRawSwapTicker } from './okxAdapter';

const NOW = Date.UTC(2026, 0, 1, 7, 30, 0);
const SETTLEMENT = Date.UTC(2026, 0, 1, 8); // 1767254400000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mapOKXToCommon', () => {
  it('[Q-02] 現況：完整 fixture，忽略回傳的 nextFundingTime 改以 + 8h 推算', () => {
    // 修正後預期：週期 = nextFundingTime − fundingTime（此例 8h），且不得以「+ 8h」推算（Invariant 4）
    const raw: OKXRawSwapTicker = {
      instId: 'BTC-USDT-SWAP',
      instType: 'SWAP',
      last: '99',
      askPx: '102',
      bidPx: '98',
      volCcy24h: '5000',
      ts: '1767252600000',
      fundingRate: '0.0000937',
      fundingTime: '1767254400000',
      nextFundingTime: '1767283200000',
      markPx: '100',
      indexPrice: '101',
      kline: { open: 100, high: 101, low: 99, close: 100.5, volume: 1200 },
    };
    expect(mapOKXToCommon(raw)).toEqual({
      exchange: 'OKX',
      symbol: 'BTCUSDT',
      event_time: 1767252600000,
      funding_time: SETTLEMENT,
      funding_rate: 0.0000937,
      next_funding_time: 1767283200000,
      mark_price: 100,
      index_price: 101,
      last_price: 99,
      bid_price: 98,
      ask_price: 102,
      volume: 5000,
      open_interest: 0,
      kline_open: 100,
      kline_high: 101,
      kline_low: 99,
      kline_close: 100.5,
      kline_volume: 1200,
      fee_rate: 0.0005,
      native_symbol: 'BTC-USDT-SWAP',
      native_field_mapping: OKX_FIELD_MAPPING_DOC,
    });
  });

  it('缺欄位 fixture：使用固定系統時間推算 8 小時邊界與預設值', () => {
    const raw = {
      instId: 'ETH-USDT-SWAP',
      instType: 'SWAP',
      last: '20',
      askPx: '',
      bidPx: '',
      volCcy24h: '',
      ts: '',
    } as OKXRawSwapTicker;
    expect(mapOKXToCommon(raw)).toEqual({
      exchange: 'OKX',
      symbol: 'ETHUSDT',
      event_time: NOW,
      funding_time: SETTLEMENT,
      funding_rate: 0,
      next_funding_time: SETTLEMENT + 8 * 3600 * 1000,
      mark_price: 20,
      index_price: 20,
      last_price: 20,
      bid_price: 20 * 0.9999,
      ask_price: 20 * 1.0001,
      volume: 0,
      open_interest: 0,
      kline_open: 20,
      kline_high: 20 * 1.0005,
      kline_low: 20 * 0.9995,
      kline_close: 20,
      kline_volume: 520000,
      fee_rate: 0.0005,
      native_symbol: 'ETH-USDT-SWAP',
      native_field_mapping: OKX_FIELD_MAPPING_DOC,
    });
  });
});
