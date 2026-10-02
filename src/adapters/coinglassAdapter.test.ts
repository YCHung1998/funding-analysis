import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCoinGlassIntelligence } from './coinglassAdapter';

const NOW = Date.UTC(2026, 0, 1, 7, 30, 0);
const SETTLEMENT = Date.UTC(2026, 0, 1, 8);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseCoinGlassIntelligence', () => {
  it('完整 fixture：只比較 Pionex 與 Binance，費率高者做空', () => {
    const result = parseCoinGlassIntelligence({
      symbol: 'BTC',
      uMarginList: [
        { exchangeName: 'Pionex', rate: 0.003, nextFundingTime: SETTLEMENT },
        { exchangeName: 'Binance', rate: 0.0001, nextFundingTime: SETTLEMENT },
        { exchangeName: 'Bybit', rate: 0.0005, nextFundingTime: SETTLEMENT },
        { exchangeName: 'OKX', rate: 0.0002, nextFundingTime: SETTLEMENT, predictedRate: 0.0003 },
      ],
    });
    expect(result).toEqual({
      symbol: 'BTCUSDT',
      source: 'CoinGlass Intelligence',
      pionex_rate: 0.003,
      binance_rate: 0.0001,
      bybit_rate: 0.0005,
      okx_rate: 0.0002,
      market_wide_spread: Math.abs(0.003 - 0.0001),
      best_arbitrage_pair: { long_exchange: 'Binance', short_exchange: 'Pionex', spread: Math.abs(0.003 - 0.0001) },
      last_updated: NOW,
    });
  });

  it('缺欄位 fixture：缺 Pionex / Binance 時預設 0.0001', () => {
    const result = parseCoinGlassIntelligence({ symbol: 'ETH', uMarginList: [] });
    expect(result).toEqual({
      symbol: 'ETHUSDT',
      source: 'CoinGlass Intelligence',
      pionex_rate: 0.0001,
      binance_rate: 0.0001,
      bybit_rate: undefined,
      okx_rate: undefined,
      market_wide_spread: 0,
      best_arbitrage_pair: { long_exchange: 'Pionex', short_exchange: 'Binance', spread: 0 },
      last_updated: NOW,
    });
  });
});
