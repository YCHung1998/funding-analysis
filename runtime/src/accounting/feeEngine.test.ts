import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_TABLE, type FeeTierConfig } from './feeConfig';
import { createDefaultFeeRateSource, estimateFee, feeForFill, FeeTierMissingError } from './feeEngine';

describe('estimateFee', () => {
  it('[Scenario] 各所 taker 手續費：1,000 USDT taker', () => {
    expect(estimateFee('Binance', 1000, 'TAKER').fee_usdt).toBeCloseTo(0.5, 9);
    expect(estimateFee('Bybit', 1000, 'TAKER').fee_usdt).toBeCloseTo(0.55, 9);
    expect(estimateFee('Bitget', 1000, 'TAKER').fee_usdt).toBeCloseTo(0.6, 9);
  });

  it('[Scenario] Maker 與 SIMULATED：Bybit 1,000 USDT', () => {
    expect(estimateFee('Bybit', 1000, 'MAKER').fee_usdt).toBeCloseTo(0.2, 9);
    expect(estimateFee('Bybit', 1000, 'SIMULATED').fee_usdt).toBeCloseTo(0.55, 9);
  });

  it('[Scenario] 雙腿來回四筆手續費：Bybit(long) x Bitget(short) 各 1000 USDT, 皆 taker', () => {
    const legs = ['Bybit', 'Bitget'] as const;
    let total = 0;
    for (const exchange of legs) {
      total += estimateFee(exchange, 1000, 'TAKER').fee_usdt * 2; // entry + exit
    }
    expect(total).toBeCloseTo(2.3, 9);
  });

  it('[Scenario] 缺少交易所費率不得默默補預設：查詢不在表中的交易所丟出 FEE_TIER_MISSING', () => {
    const table: FeeTierConfig[] = DEFAULT_FEE_TABLE.filter((row) => row.exchange !== 'Binance');
    expect(() => estimateFee('Binance', 1000, 'TAKER', table)).toThrow(FeeTierMissingError);
  });

  it('不得依交易所名稱分支：移除 Pionex 後其餘查表邏輯不受影響', () => {
    const table: FeeTierConfig[] = DEFAULT_FEE_TABLE.filter((row) => row.exchange !== 'Pionex');
    expect(estimateFee('Binance', 1000, 'TAKER', table).fee_usdt).toBeCloseTo(0.5, 9);
  });

  it('fee_config_version 隨表內容變動', () => {
    const v1 = estimateFee('Binance', 1000, 'TAKER').fee_config_version;
    const overridden = DEFAULT_FEE_TABLE.map((row) => (row.exchange === 'Binance' ? { ...row, taker_fee: 0.00045 } : row));
    const v2 = estimateFee('Binance', 1000, 'TAKER', overridden).fee_config_version;
    expect(v2).not.toBe(v1);
    expect(estimateFee('Binance', 1000, 'TAKER', overridden).fee_usdt).toBeCloseTo(0.45, 9);
  });

  it('輸入驗證：NaN / Infinity / undefined 名目金額 MUST 拋出，不得默默回傳「獲利」數字', () => {
    expect(() => estimateFee('Binance', NaN, 'TAKER')).toThrow(TypeError);
    expect(() => estimateFee('Binance', Infinity, 'TAKER')).toThrow(TypeError);
    // @ts-expect-error intentional invalid input for runtime guard test
    expect(() => estimateFee('Binance', undefined, 'TAKER')).toThrow(TypeError);
  });
});

describe('feeForFill', () => {
  it('以成交價 x 數量算名目後計費', () => {
    expect(feeForFill('Binance', 100, 10, 'TAKER').fee_usdt).toBeCloseTo(0.5, 9);
  });

  it('輸入驗證：NaN 價格或數量拋出', () => {
    expect(() => feeForFill('Binance', NaN, 10, 'TAKER')).toThrow(TypeError);
    expect(() => feeForFill('Binance', 100, NaN, 'TAKER')).toThrow(TypeError);
  });
});

describe('FeeRateSource（供 paper-execution-engine）', () => {
  it('getTakerFeeRate / getMakerFeeRate 回傳小數費率', () => {
    const source = createDefaultFeeRateSource();
    expect(source.getTakerFeeRate('Binance')).toBeCloseTo(0.0005, 9);
    expect(source.getMakerFeeRate('Binance')).toBeCloseTo(0.0002, 9);
  });
});
