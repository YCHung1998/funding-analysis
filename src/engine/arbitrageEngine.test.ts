import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  enrichKlineBar,
  estimateSlippageRate,
  resolveLegFeeRates,
  simulateExecutionExperiment,
} from './arbitrageEngine';
import type { CommonFundingRecord, ExchangeId, SettlementWindowBar, WindowOffset } from '../types/schema';

const FUNDING_TIME = Date.UTC(2026, 0, 1, 8);

function record(exchange: ExchangeId, fundingRate: number, overrides: Partial<CommonFundingRecord> = {}): CommonFundingRecord {
  return {
    exchange,
    symbol: 'BTCUSDT',
    event_time: FUNDING_TIME,
    funding_time: FUNDING_TIME,
    funding_rate: fundingRate,
    next_funding_time: FUNDING_TIME + 8 * 3600_000,
    mark_price: 100,
    index_price: 100,
    last_price: 100,
    bid_price: 99.99,
    ask_price: 100.01,
    volume: 1_000_000,
    open_interest: 1_000_000,
    kline_open: 100,
    kline_high: 100,
    kline_low: 100,
    kline_close: 100,
    kline_volume: 1000,
    fee_rate: 0.0005,
    native_symbol: 'BTCUSDT',
    native_field_mapping: {},
    ...overrides,
  };
}

function flatBars(exchange: ExchangeId): SettlementWindowBar[] {
  const offsets: WindowOffset[] = ['T-2m', 'T-1m', 'T', 'T+1m', 'T+2m'];
  return offsets.map((offset_label, i) =>
    enrichKlineBar({
      exchange,
      symbol: 'BTCUSDT',
      funding_time: FUNDING_TIME,
      kline_time: FUNDING_TIME + (i - 2) * 60_000,
      offset_label,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1000,
    }),
  );
}

describe('enrichKlineBar', () => {
  it('計算價格變化、區間、報酬率、波動與量能衝擊', () => {
    const bar = enrichKlineBar(
      { exchange: 'Binance', symbol: 'BTCUSDT', funding_time: 0, kline_time: 0, offset_label: 'T', open: 100, high: 102, low: 99, close: 101, volume: 500 },
      250,
    );
    expect(bar.price_change).toBe(1);
    expect(bar.high_low_range).toBe(3);
    expect(bar.return_pct).toBeCloseTo(1, 9);
    expect(bar.volatility).toBeCloseTo(3, 9);
    expect(bar.volume_shock_ratio).toBe(2);
  });

  it('open = 0 時報酬率與波動為 0；無 baselineVol 時衝擊為 1', () => {
    const bar = enrichKlineBar({ exchange: 'Binance', symbol: 'BTCUSDT', funding_time: 0, kline_time: 0, offset_label: 'T', open: 0, high: 5, low: 0, close: 5, volume: 500 });
    expect(bar.return_pct).toBe(0);
    expect(bar.volatility).toBe(0);
    expect(bar.volume_shock_ratio).toBe(1);
  });
});

describe('estimateSlippageRate', () => {
  it('滑價下限 1 bp', () => {
    expect(estimateSlippageRate(0, 1, 100, 100, 100)).toBe(0.0001);
  });

  it('衝擊倍數上限 2.5', () => {
    // 半價差 1% + 波動 1% × 0.12 × 2.5 = 1.3% → 0.013
    expect(estimateSlippageRate(1, 10, 99, 101, 100)).toBeCloseTo(0.013, 9);
  });

  it('衝擊倍數下限 0.8', () => {
    // 半價差 1% + 波動 1% × 0.12 × 0.8 = 1.096% → 0.01096
    expect(estimateSlippageRate(1, 1, 99, 101, 100)).toBeCloseTo(0.01096, 9);
  });

  it('midPrice = 0 時基礎價差為 0.01%', () => {
    // 0.01 × 0.5 + 1 × 0.12 × 1.0 = 0.125% → 0.00125
    expect(estimateSlippageRate(1, 2, 0, 0, 0)).toBeCloseTo(0.00125, 9);
  });
});

describe('resolveLegFeeRates', () => {
  it('[Scenario] ExecutionSimulator 手續費依腿別對應（Q-06）：Pionex 為 short 腿，short 端 0.0006、long 端 0.0005', () => {
    const { pionexFeeRate, binanceFeeRate } = resolveLegFeeRates({
      pionexIsShort: true,
      longFeeRate: 0.0005,
      shortFeeRate: 0.0006,
    });
    expect(pionexFeeRate).toBeCloseTo(0.0006, 9); // Pionex is the short leg -> gets the short-end fee
    expect(binanceFeeRate).toBeCloseTo(0.0005, 9);
    expect(1000 * pionexFeeRate).toBeCloseTo(0.6, 9);
    expect(1000 * binanceFeeRate).toBeCloseTo(0.5, 9);
  });

  it('Pionex 為 long 腿時手續費對調（不再是固定 longFee -> pionex 的錯置）', () => {
    const { pionexFeeRate, binanceFeeRate } = resolveLegFeeRates({
      pionexIsShort: false,
      longFeeRate: 0.0005,
      shortFeeRate: 0.0006,
    });
    expect(pionexFeeRate).toBeCloseTo(0.0005, 9);
    expect(binanceFeeRate).toBeCloseTo(0.0006, 9);
  });
});

describe('simulateExecutionExperiment', () => {
  const zeroFeeConfig = { ...DEFAULT_CONFIG, pionex_taker_fee: 0, binance_taker_fee: 0, custom_entry_slippage: 0.0003 };

  it('[Q-05] 修正後：滑價已反映在成交價，net_pnl 不再重複扣除，≈ −1.20', () => {
    const result = simulateExecutionExperiment(
      record('Pionex', 0.0001),
      record('Binance', 0.0001),
      flatBars('Pionex'),
      flatBars('Binance'),
      zeroFeeConfig,
    );
    expect(result.price_pnl).toBeCloseTo(-1.200000108, 9);
    // total_slippage 保留為歸因顯示欄位，不再從 net 扣除
    expect(result.total_slippage).toBeCloseTo(1.2, 9);
    expect(result.funding_pnl).toBeCloseTo(0, 9);
    // 修正前（現況）為 ≈ −2.40（滑價被扣兩次）；修正後 net = gross - fee，不再減 total_slippage
    expect(result.net_pnl).toBeCloseTo(-1.200000108, 2);
    expect(result.net_pnl).not.toBeCloseTo(-2.400000108, 2);
  });

  it('費率相同時 Pionex 做空', () => {
    const result = simulateExecutionExperiment(record('Pionex', 0.0001), record('Binance', 0.0001), flatBars('Pionex'), flatBars('Binance'));
    expect(result.pionex_leg.side).toBe('SHORT');
    expect(result.binance_leg.side).toBe('LONG');
  });

  it('Binance 費率較高時 Binance 做空，並依方向計算資金費', () => {
    const result = simulateExecutionExperiment(record('Pionex', 0.0001), record('Binance', 0.0005), flatBars('Pionex'), flatBars('Binance'), zeroFeeConfig);
    expect(result.pionex_leg.side).toBe('LONG');
    expect(result.binance_leg.side).toBe('SHORT');
    expect(result.pionex_leg.funding_pnl).toBeCloseTo(-0.1, 9);
    expect(result.binance_leg.funding_pnl).toBeCloseTo(0.5, 9);
    expect(result.spread).toBeCloseTo(0.0004, 12);
    expect(result.meets_research_threshold).toBe(false);
  });

  it('預設設定下 4 筆 taker 費共 2.00 USDT', () => {
    const result = simulateExecutionExperiment(record('Pionex', 0.003), record('Binance', 0.0001), flatBars('Pionex'), flatBars('Binance'));
    expect(result.total_entry_fee).toBeCloseTo(1, 9);
    expect(result.total_exit_fee).toBeCloseTo(1, 9);
    expect(result.total_fee).toBeCloseTo(2, 9);
    expect(result.meets_research_threshold).toBe(true);
  });

  it('結算時間字串與 id 格式', () => {
    const result = simulateExecutionExperiment(record('Pionex', 0.0001), record('Binance', 0.0001), flatBars('Pionex'), flatBars('Binance'));
    expect(result.funding_time_str).toBe('2026-01-01 08:00:00 UTC');
    expect(result.id).toBe('BTCUSDT-1767254400000');
  });
});
