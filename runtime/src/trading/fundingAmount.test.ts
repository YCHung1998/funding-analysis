/**
 * runtime/src/trading/fundingAmount.test.ts
 *
 * Task 3.1 — fundingAmount hook per settlement_status (design.md Decision
 * 6): EXPECTED +1.80, ELIGIBLE recomputed +1.791, SETTLED +1.00 and the
 * SNAPSHOT mark-price-source case +0.501, NOT_ELIGIBLE 0, MISSED absent.
 */
import { describe, expect, it } from 'vitest';
import { fundingAmount } from './fundingAmount';

describe('fundingAmount', () => {
  it('EXPECTED: predicted rate x target quantity x current mark -> +1.80 (SHORT receives)', () => {
    const result = fundingAmount('EXPECTED', { side: 'SHORT', quantity: 1, mark_price: 90, funding_rate: 0.02 });
    expect(result.expected_cashflow_usdt).toBeCloseTo(1.8, 10);
    expect(result.actual_cashflow_usdt).toBeUndefined();
  });

  it('ELIGIBLE: recomputed with the actual base_quantity at lock_end -> +1.791', () => {
    const result = fundingAmount('ELIGIBLE', { side: 'SHORT', quantity: 0.995, mark_price: 90, funding_rate: 0.02 });
    expect(result.expected_cashflow_usdt).toBeCloseTo(1.791, 10);
  });

  it('SETTLED: settled rate x qty_at_T x mark_T -> +1.00, writes position_notional / settled_funding_rate / overwritten funding_rate', () => {
    const result = fundingAmount('SETTLED', { side: 'SHORT', quantity: 1, mark_price: 100, funding_rate: 0.01 });
    expect(result.actual_cashflow_usdt).toBeCloseTo(1.0, 10);
    expect(result.position_notional).toBeCloseTo(100, 10);
    expect(result.settled_funding_rate).toBe(0.01);
    expect(result.funding_rate).toBe(0.01); // overwrites the predicted rate (Q-04)
  });

  it('SETTLED with SNAPSHOT mark price source (Bybit, no settlement-record mark) -> +0.501', () => {
    const result = fundingAmount('SETTLED', { side: 'SHORT', quantity: 1, mark_price: 100.2, funding_rate: 0.005 });
    expect(result.actual_cashflow_usdt).toBeCloseTo(0.501, 10);
  });

  it('SETTLED: LONG pays when rate is positive (sign flips vs SHORT)', () => {
    const result = fundingAmount('SETTLED', { side: 'LONG', quantity: 1, mark_price: 100, funding_rate: 0.01 });
    expect(result.actual_cashflow_usdt).toBeCloseTo(-1.0, 10);
  });

  it('NOT_ELIGIBLE: actual_cashflow_usdt is always 0', () => {
    const result = fundingAmount('NOT_ELIGIBLE', { side: 'LONG', quantity: 1, mark_price: 100, funding_rate: 0.01 });
    expect(result.actual_cashflow_usdt).toBe(0);
    expect(result.expected_cashflow_usdt).toBeUndefined();
  });

  it('MISSED: actual_cashflow_usdt is absent (not 0) so callers can distinguish "no data" from "zero"', () => {
    const result = fundingAmount('MISSED', { side: 'LONG', quantity: 1, mark_price: 100, funding_rate: 0.01 });
    expect(result.actual_cashflow_usdt).toBeUndefined();
    expect('actual_cashflow_usdt' in result).toBe(false);
  });
});
