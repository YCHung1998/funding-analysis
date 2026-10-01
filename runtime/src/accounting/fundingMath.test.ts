import { describe, expect, it } from 'vitest';
import { computeSettlementCashflow } from '../funding/settlementInference';
import { fundingCashflow } from './fundingMath';

describe('fundingCashflow', () => {
  it('[Scenario] 價格上漲後的資金費（Q-07）：SHORT 10, mark 101, rate 0.0010', () => {
    const cashflow = fundingCashflow({ side: 'SHORT', baseQuantity: 10, markPrice: 101, rate: 0.001 });
    expect(cashflow).toBeCloseTo(1.01, 9);
    expect(cashflow).not.toBeCloseTo(1.0, 9); // not fixed notional (1000) * rate
  });

  it('[Scenario] 資金費正負號：數量 10, mark 101', () => {
    expect(fundingCashflow({ side: 'LONG', baseQuantity: 10, markPrice: 101, rate: 0.0005 })).toBeCloseTo(-0.505, 9);
    expect(fundingCashflow({ side: 'LONG', baseQuantity: 10, markPrice: 101, rate: -0.0005 })).toBeCloseTo(0.505, 9);
    expect(fundingCashflow({ side: 'SHORT', baseQuantity: 10, markPrice: 101, rate: -0.0005 })).toBeCloseTo(-0.505, 9);
  });

  it('[Scenario] 與結算規則一致：SHORT 10, mark 100, 已結算費率 0.0010', () => {
    const viaFundingMath = fundingCashflow({ side: 'SHORT', baseQuantity: 10, markPrice: 100, rate: 0.001 });
    const viaSettlementRules = computeSettlementCashflow({ side: 'SHORT', quantity: 10, settledRate: 0.001, markPrice: 100 });
    expect(viaFundingMath).toBeCloseTo(1.0, 9);
    expect(viaFundingMath).toBeCloseTo(viaSettlementRules, 12);
  });

  it('是唯一實作：直接委派給 computeSettlementCashflow，不重新定義公式', () => {
    const input = { side: 'LONG' as const, baseQuantity: 7, markPrice: 55, rate: 0.0012 };
    expect(fundingCashflow(input)).toBe(
      computeSettlementCashflow({ side: input.side, quantity: input.baseQuantity, settledRate: input.rate, markPrice: input.markPrice }),
    );
  });

  it('輸入驗證：NaN / Infinity / undefined 拋出，不得默默產生獲利數字', () => {
    expect(() => fundingCashflow({ side: 'LONG', baseQuantity: NaN, markPrice: 100, rate: 0.001 })).toThrow(TypeError);
    expect(() => fundingCashflow({ side: 'LONG', baseQuantity: 10, markPrice: Infinity, rate: 0.001 })).toThrow(TypeError);
    // @ts-expect-error intentional invalid input for runtime guard test
    expect(() => fundingCashflow({ side: 'LONG', baseQuantity: 10, markPrice: 100, rate: undefined })).toThrow(TypeError);
  });
});
