/**
 * runtime/src/accounting/pnlEngine.test.ts
 *
 * Task 4.1 — aggregatePnl / legFundingPnl / roiOnNotional / roiOnCapital
 * (design.md Decision 7). Includes the Q-05 "slippage not double-subtracted"
 * regression (S01: net = -0.50, NOT -0.90) and the ✅ C-17 ROI examples from
 * tasks.md 4.1 (single-leg -0.30%, zero-fill 0).
 */
import { describe, expect, it } from 'vitest';
import { aggregatePnl, legFundingPnl, roiOnCapital, roiOnNotional, type LegPnlInput } from './pnlEngine';

describe('legFundingPnl', () => {
  it('SETTLED -> actual_cashflow_usdt', () => {
    expect(legFundingPnl({ funding_settlement_status: 'SETTLED', actual_cashflow_usdt: 1.5, expected_cashflow_usdt: 2 })).toBe(1.5);
  });
  it('EXPECTED/ELIGIBLE -> expected_cashflow_usdt (provisional)', () => {
    expect(legFundingPnl({ funding_settlement_status: 'EXPECTED', expected_cashflow_usdt: 2 })).toBe(2);
    expect(legFundingPnl({ funding_settlement_status: 'ELIGIBLE', expected_cashflow_usdt: 1.9 })).toBe(1.9);
  });
  it('NOT_ELIGIBLE / MISSED / no settlement -> 0 (Q-08: a failed leg never borrows the other leg\'s funding)', () => {
    expect(legFundingPnl({ funding_settlement_status: 'NOT_ELIGIBLE', actual_cashflow_usdt: 0 })).toBe(0);
    expect(legFundingPnl({ funding_settlement_status: 'MISSED' })).toBe(0);
    expect(legFundingPnl({})).toBe(0);
  });
});

describe('aggregatePnl — Q-05 regression: slippage must not be subtracted twice', () => {
  it('S01: funding 2.0 + price -1.1 (already incl. -0.4 slippage) - fee 1.4 -> net -0.50, NOT -0.90', () => {
    const legs: LegPnlInput[] = [
      {
        realized_price_pnl_usdt: -1.1,
        fees_usdt: 1.4,
        slippage_attribution_usdt: -0.4, // already inside realized_price_pnl_usdt above
        funding_settlement_status: 'SETTLED',
        actual_cashflow_usdt: 2.0,
      },
    ];
    const result = aggregatePnl(legs);
    expect(result.net_pnl_usdt).toBeCloseTo(-0.5, 10);
    expect(result.net_pnl_usdt).not.toBeCloseTo(-0.9, 2); // the Q-05 bug would double-subtract the 0.4 slippage
    expect(result.slippage_attribution_usdt).toBe(-0.4); // reported for attribution only, not re-subtracted
  });

  it('sums across both legs (2-leg normal case)', () => {
    const legs: LegPnlInput[] = [
      { realized_price_pnl_usdt: 0.08, fees_usdt: 1.0, slippage_attribution_usdt: -0.2, funding_settlement_status: 'SETTLED', actual_cashflow_usdt: -0.1 },
      { realized_price_pnl_usdt: -0.09, fees_usdt: 1.1, slippage_attribution_usdt: -0.2, funding_settlement_status: 'SETTLED', actual_cashflow_usdt: 2.1 },
    ];
    const result = aggregatePnl(legs);
    expect(result.price_pnl_usdt).toBeCloseTo(-0.01, 10);
    expect(result.fee_usdt).toBeCloseTo(2.1, 10);
    expect(result.funding_pnl_usdt).toBeCloseTo(2.0, 10);
    expect(result.net_pnl_usdt).toBeCloseTo(2.0 - 0.01 - 2.1, 10);
  });
});

describe('roiOnNotional / roiOnCapital (✅ C-17)', () => {
  it('S01: net -0.50 over actual notional 2001 and allocated capital 454 -> -0.02499% / -0.11013%', () => {
    expect(roiOnNotional(-0.5, 1000.5, 1000.5)).toBeCloseTo(-0.02499, 5);
    expect(roiOnCapital(-0.5, 454)).toBeCloseTo(-0.11013, 5);
  });

  it('single-leg EMERGENCY_EXIT: net -3.00 over long-only notional 1000 (short never filled) -> -0.30%', () => {
    expect(roiOnNotional(-3.0, 1000, 0)).toBeCloseTo(-0.3, 10);
  });

  it('zero-fill ABORTED: no notional at all -> 0 (guarded against divide-by-zero)', () => {
    expect(roiOnNotional(0, 0, 0)).toBe(0);
    expect(roiOnCapital(0, 0)).toBe(0);
  });
});
