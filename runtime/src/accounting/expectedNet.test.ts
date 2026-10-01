import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_TABLE } from './feeConfig';
import {
  estimateExpectedNet,
  evaluatePredictedRateRisk,
  meetsNetThreshold,
  rankByNet,
  selectBestPair,
  type ExpectedNetInput,
} from './expectedNet';

const ZERO_BUFFER_CONFIG = {
  slippage_safety_buffer_pct: 0,
  liquidity_assumption: 'TAKER' as const,
  basis_convergence_assumption: 'ADVERSE_ONLY' as const,
  basis_risk_z: 1,
  basis_sigma_pct: 0,
};

function flatQuote(price: number) {
  return { kind: 'TOP_OF_BOOK' as const, bestBid: price, bestAsk: price };
}

function baseInput(overrides: Partial<ExpectedNetInput> = {}): ExpectedNetInput {
  return {
    long: {
      exchange: 'Binance',
      mid_price: 100,
      mark_price: 100,
      predicted_rate: 0,
      quote: flatQuote(100),
    },
    short: {
      exchange: 'Bybit',
      mid_price: 100,
      mark_price: 100,
      predicted_rate: 0,
      quote: flatQuote(100),
    },
    target_notional_per_leg_usdt: 1000,
    qty_step_long: 0.001,
    qty_step_short: 0.001,
    config: ZERO_BUFFER_CONFIG,
    ...overrides,
  };
}

describe('estimateExpectedNet', () => {
  it('[Scenario] 數量依 step size 無條件捨去：1000 USDT / 99.995, step 0.001 -> 10.000', () => {
    const result = estimateExpectedNet(
      baseInput({
        long: { exchange: 'Binance', mid_price: 99.995, mark_price: 99.995, predicted_rate: 0, quote: flatQuote(99.995) },
      }),
    );
    expect(result.quantity_long).toBeCloseTo(10.0, 9);
  });

  it('[Scenario] 完整淨值拆解', () => {
    const result = estimateExpectedNet(
      baseInput({
        long: { exchange: 'Binance', mid_price: 100, mark_price: 100, predicted_rate: -0.0002, quote: flatQuote(100) },
        short: { exchange: 'Bybit', mid_price: 100, mark_price: 100, predicted_rate: 0.0018, quote: flatQuote(100) },
        config: { ...ZERO_BUFFER_CONFIG, slippage_safety_buffer_pct: 0.0001 },
      }),
    );
    expect(result.quantity_long).toBeCloseTo(10, 9);
    expect(result.expected_funding_usdt).toBeCloseTo(2.0, 9);
    expect(result.expected_fees_usdt).toBeCloseTo(2.1, 9);
    expect(result.expected_slippage_attribution_usdt).toBeCloseTo(-0.4, 9);
    expect(result.expected_price_pnl_usdt).toBeCloseTo(-0.4, 9);
    expect(result.expected_net_pnl_usdt).toBeCloseTo(-0.5, 9);
    // 若重複扣滑價會得到 -0.90
    expect(result.expected_net_pnl_usdt).not.toBeCloseTo(-0.9, 9);
    expect(result.fee_config_version).toBeTruthy();
    expect(result.cost_model_version).toBeTruthy();
  });

  it('[Scenario] 不利 basis 納入', () => {
    const zeroFeeTable = DEFAULT_FEE_TABLE.map((row) => ({ ...row, maker_fee: 0, taker_fee: 0 }));
    const result = estimateExpectedNet(
      baseInput({
        long: { exchange: 'Binance', mid_price: 100.0, mark_price: 100.0, predicted_rate: 0, quote: flatQuote(100.0) },
        short: { exchange: 'Bybit', mid_price: 99.8, mark_price: 99.8, predicted_rate: 0, quote: flatQuote(99.8) },
        config: { ...ZERO_BUFFER_CONFIG, fee_table: zeroFeeTable },
      }),
    );
    expect(result.entry_basis_pct).toBeCloseTo(-0.002, 9);
    expect(result.expected_basis_pnl_usdt).toBeCloseTo(-2.0, 9);
  });

  it('[Scenario] 有利 basis 在保守假設下不計入', () => {
    const result = estimateExpectedNet(
      baseInput({
        long: { exchange: 'Binance', mid_price: 100.0, mark_price: 100.0, predicted_rate: 0, quote: flatQuote(100.0) },
        short: { exchange: 'Bybit', mid_price: 100.2, mark_price: 100.2, predicted_rate: 0, quote: flatQuote(100.2) },
      }),
    );
    expect(result.entry_basis_pct).toBeCloseTo(0.002, 9);
    expect(result.expected_basis_pnl_usdt).toBe(0);
  });

  it('[Scenario] Basis 風險折價：z=1.0, sigma=0.0005, 單腿 1000', () => {
    const result = estimateExpectedNet(baseInput({ config: { ...ZERO_BUFFER_CONFIG, basis_risk_z: 1.0, basis_sigma_pct: 0.0005 } }));
    expect(result.basis_risk_charge_usdt).toBeCloseTo(0.5, 9);
  });

  it('滑價 UNAVAILABLE 時 qualified=false 且 reason=SLIPPAGE_UNAVAILABLE，不以常數補足', () => {
    const result = estimateExpectedNet(
      baseInput({ long: { exchange: 'Binance', mid_price: 100, mark_price: 100, predicted_rate: 0, quote: { kind: 'UNAVAILABLE' } } }),
    );
    expect(result.qualified).toBe(false);
    expect(result.reason).toBe('SLIPPAGE_UNAVAILABLE');
    expect(result.expected_net_pnl_usdt).not.toBeGreaterThan(0); // 不得默默產生「獲利」
  });

  it('輸入驗證：target_notional 非正數或非有限時拋出', () => {
    expect(() => estimateExpectedNet(baseInput({ target_notional_per_leg_usdt: NaN }))).toThrow(TypeError);
    expect(() => estimateExpectedNet(baseInput({ target_notional_per_leg_usdt: 0 }))).toThrow(TypeError);
    expect(() => estimateExpectedNet(baseInput({ target_notional_per_leg_usdt: -1 }))).toThrow(TypeError);
  });
});

describe('selectBestPair / rankByNet / meetsNetThreshold', () => {
  it('[Scenario] 毛 spread 通過但淨值為負（Q-06 MEW）', () => {
    const input = baseInput({
      long: { exchange: 'Bybit', mid_price: 100, mark_price: 100, predicted_rate: 0, quote: flatQuote(100) },
      short: { exchange: 'Bitget', mid_price: 100, mark_price: 100, predicted_rate: 0.00208, quote: flatQuote(100) },
    });
    const result = estimateExpectedNet(input);
    expect(result.net_spread_pct).toBeCloseTo(-0.00022, 5);
    const threshold = meetsNetThreshold(result, { minimum_expected_net_pnl_usdt: 0, minimum_net_spread_pct: -Infinity });
    expect(threshold.qualified).toBe(false);
    expect(threshold.reason).toBe('BELOW_MIN_NET_PNL');
  });

  it('[Scenario] Best pair 依淨值而非毛 spread', () => {
    const p1 = estimateExpectedNet(
      baseInput({
        long: { exchange: 'Bybit', mid_price: 100, mark_price: 100, predicted_rate: -0.0004, quote: flatQuote(100) },
        short: { exchange: 'Bitget', mid_price: 100, mark_price: 100, predicted_rate: 0.002, quote: flatQuote(100) },
      }),
    );
    const p2 = estimateExpectedNet(
      baseInput({
        long: { exchange: 'Binance', mid_price: 100, mark_price: 100, predicted_rate: -0.0003, quote: flatQuote(100) },
        short: { exchange: 'OKX', mid_price: 100, mark_price: 100, predicted_rate: 0.002, quote: flatQuote(100) },
      }),
    );
    expect(p1.net_spread_pct).toBeCloseTo(0.0001, 6);
    expect(p2.net_spread_pct).toBeCloseTo(0.0003, 6);

    const best = selectBestPair([
      { id: 'P1', result: p1 },
      { id: 'P2', result: p2 },
    ]);
    expect(best?.id).toBe('P2');
  });

  it('[Scenario] 排序依淨值', () => {
    const candidates = [
      { id: 'A', symbol: 'A', result: { net_spread_pct: 0.0002, expected_net_pnl_usdt: 2 } },
      { id: 'B', symbol: 'B', result: { net_spread_pct: 0.0008, expected_net_pnl_usdt: 8 } },
    ];
    const ranked = rankByNet(candidates);
    expect(ranked.map((c) => c.id)).toEqual(['B', 'A']);
  });
});

describe('evaluatePredictedRateRisk', () => {
  const basePair = (longRate: number, shortRate: number): ExpectedNetInput =>
    baseInput({
      long: { exchange: 'Binance', mid_price: 100, mark_price: 100, predicted_rate: longRate, quote: flatQuote(100) },
      short: { exchange: 'Bybit', mid_price: 100, mark_price: 100, predicted_rate: shortRate, quote: flatQuote(100) },
    });

  it('[Scenario] Spread 在 ARM 前縮小（Q-04）', () => {
    const evaluated = basePair(0.0, 0.0025);
    const latest = basePair(0.0, 0.001);
    const evaluatedResult = estimateExpectedNet(evaluated);
    expect(evaluatedResult.expected_net_pnl_usdt).toBeCloseTo(0.4, 9);

    const outcome = evaluatePredictedRateRisk(evaluated, latest, { minimum_expected_net_pnl_usdt: 0.2 });
    expect(outcome.recomputed.expected_net_pnl_usdt).toBeCloseTo(-1.1, 9);
    expect(outcome.result).toBe('BELOW_MIN_NET_PNL');
  });

  it('[Scenario] Spread 翻轉', () => {
    const evaluated = basePair(0.0, 0.0025);
    const latest = basePair(0.0012, 0.0002);
    const outcome = evaluatePredictedRateRisk(evaluated, latest, { minimum_expected_net_pnl_usdt: 0.2 });
    expect(outcome.result).toBe('SPREAD_FLIPPED');
  });
});
