import { describe, expect, it } from 'vitest';
import {
  computeFeeConfigVersion,
  DEFAULT_FEE_TABLE,
  FeeConfigError,
  validateFeeTable,
  type FeeTierConfig,
} from './feeConfig';

describe('DEFAULT_FEE_TABLE', () => {
  it('spec §3 預設表：Binance/OKX/Pionex 0.02%/0.05%、Bybit 0.02%/0.055%、Bitget 0.02%/0.06%，標示 DEFAULT_ESTIMATE', () => {
    const byExchange = Object.fromEntries(DEFAULT_FEE_TABLE.map((row) => [row.exchange, row]));
    expect(byExchange.Binance).toMatchObject({ maker_fee: 0.0002, taker_fee: 0.0005, source: 'DEFAULT_ESTIMATE' });
    expect(byExchange.OKX).toMatchObject({ maker_fee: 0.0002, taker_fee: 0.0005, source: 'DEFAULT_ESTIMATE' });
    expect(byExchange.Pionex).toMatchObject({ maker_fee: 0.0002, taker_fee: 0.0005, source: 'DEFAULT_ESTIMATE' });
    expect(byExchange.Bybit).toMatchObject({ maker_fee: 0.0002, taker_fee: 0.00055, source: 'DEFAULT_ESTIMATE' });
    expect(byExchange.Bitget).toMatchObject({ maker_fee: 0.0002, taker_fee: 0.0006, source: 'DEFAULT_ESTIMATE' });
  });

  it('預設表本身驗證通過', () => {
    expect(() => validateFeeTable(DEFAULT_FEE_TABLE)).not.toThrow();
  });
});

describe('validateFeeTable', () => {
  it('[Scenario] 百分比誤填被拒絕：Binance taker_fee = 0.05 視為超出範圍', () => {
    const table: FeeTierConfig[] = [
      { exchange: 'Binance', tier_name: 'VIP0', maker_fee: 0.0002, taker_fee: 0.05, source: 'CONFIG', is_default_lowest: true },
    ];
    try {
      validateFeeTable(table);
      throw new Error('expected validateFeeTable to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FeeConfigError);
      expect((err as FeeConfigError).code).toBe('FEE_RATE_OUT_OF_RANGE');
      expect((err as FeeConfigError).message).toContain('Binance.taker_fee');
    }
  });

  it('允許 maker rebate（負費率）在範圍內', () => {
    const table: FeeTierConfig[] = [
      { exchange: 'Binance', tier_name: 'VIP9', maker_fee: -0.0001, taker_fee: 0.0002, source: 'CONFIG', is_default_lowest: true },
    ];
    expect(() => validateFeeTable(table)).not.toThrow();
  });

  it('超出下界 (< -0.001) 被拒絕', () => {
    const table: FeeTierConfig[] = [
      { exchange: 'Binance', tier_name: 'VIP9', maker_fee: -0.002, taker_fee: 0.0002, source: 'CONFIG', is_default_lowest: true },
    ];
    expect(() => validateFeeTable(table)).toThrow(FeeConfigError);
  });

  it('NaN / Infinity 費率被拒絕，不得默默視為可用', () => {
    const table: FeeTierConfig[] = [
      { exchange: 'Binance', tier_name: 'VIP0', maker_fee: NaN, taker_fee: 0.0005, source: 'CONFIG', is_default_lowest: true },
    ];
    expect(() => validateFeeTable(table)).toThrow(FeeConfigError);
  });
});

describe('computeFeeConfigVersion', () => {
  it('[Scenario] VIP 覆寫不需改程式：費率變動後版本也隨之改變', () => {
    const v1 = computeFeeConfigVersion(DEFAULT_FEE_TABLE);
    const overridden: FeeTierConfig[] = DEFAULT_FEE_TABLE.map((row) =>
      row.exchange === 'Binance' ? { ...row, tier_name: 'VIP1', taker_fee: 0.00045 } : row,
    );
    const v2 = computeFeeConfigVersion(overridden);
    expect(v2).not.toBe(v1);
  });

  it('相同內容 (順序不同) 產生相同版本', () => {
    const shuffled = [...DEFAULT_FEE_TABLE].reverse();
    expect(computeFeeConfigVersion(shuffled)).toBe(computeFeeConfigVersion(DEFAULT_FEE_TABLE));
  });
});
