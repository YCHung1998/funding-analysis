import { describe, expect, it } from 'vitest';
import { composeNetPnl, slippageAttribution } from './pnlFormula';

describe('slippageAttribution', () => {
  it('[Scenario] BUY 與 SELL 的歸因', () => {
    expect(slippageAttribution('BUY', 250, 100.006, 99.995)).toBeCloseTo(-2.75, 2);
    expect(slippageAttribution('SELL', 100, 99.985, 99.995)).toBeCloseTo(-1.0, 2);
  });

  it('輸入驗證：NaN / Infinity 拋出', () => {
    expect(() => slippageAttribution('BUY', NaN, 100, 100)).toThrow(TypeError);
    expect(() => slippageAttribution('BUY', 10, Infinity, 100)).toThrow(TypeError);
  });
});

describe('composeNetPnl', () => {
  it('[Scenario] 滑價不被重複扣除：LONG 10, 進場參考 100 實際 100.05, 出場參考 100 實際 99.95', () => {
    const entryAttr = slippageAttribution('BUY', 10, 100.05, 100);
    const exitAttr = slippageAttribution('SELL', 10, 99.95, 100);
    const referencePricePnl = (100 - 100) * 10; // exit_ref - entry_ref, LONG
    const actualPricePnl = (99.95 - 100.05) * 10;
    const totalAttribution = entryAttr + exitAttr;

    expect(totalAttribution).toBeCloseTo(-1.0, 9);
    expect(referencePricePnl + totalAttribution).toBeCloseTo(actualPricePnl, 9);

    const netPnl = composeNetPnl({ funding_pnl: 0, price_pnl: actualPricePnl, fees: 0, other_costs: 0 });
    expect(netPnl).toBeCloseTo(-1.0, 9);
    expect(netPnl).not.toBeCloseTo(-2.0, 9);
  });

  it('[Scenario] 含其他成本', () => {
    expect(composeNetPnl({ funding_pnl: 2.0, price_pnl: -0.4, fees: 2.1, other_costs: 0.5 })).toBeCloseTo(-1.0, 9);
  });

  it('composeNetPnl 的參數型別沒有滑價欄位（型別層面阻止重複扣除）', () => {
    const input = { funding_pnl: 1, price_pnl: 1, fees: 1, other_costs: 1 };
    // @ts-expect-error composeNetPnl input must not accept a slippage field
    composeNetPnl({ ...input, slippage: 5 });
  });

  it('輸入驗證：任何欄位為 NaN / Infinity / undefined 時拋出', () => {
    expect(() => composeNetPnl({ funding_pnl: NaN, price_pnl: 0, fees: 0, other_costs: 0 })).toThrow(TypeError);
    expect(() => composeNetPnl({ funding_pnl: 0, price_pnl: Infinity, fees: 0, other_costs: 0 })).toThrow(TypeError);
    // @ts-expect-error intentional invalid input for runtime guard test
    expect(() => composeNetPnl({ funding_pnl: 0, price_pnl: 0, fees: undefined, other_costs: 0 })).toThrow(TypeError);
  });
});
