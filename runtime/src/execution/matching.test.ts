/**
 * runtime/src/execution/matching.test.ts
 *
 * Task 2.2 — pure `matching.ts` functions: tech spec §14 example (avg price
 * 100.006), SELL walks bids, not-best-ask, step-size validation.
 */
import { describe, expect, it } from 'vitest';
import { averageFillPrice, feeUsdt, isValidStep, notionalUsdt, slippagePct, walkBook } from './matching';

describe('walkBook', () => {
  it('tech spec §14 example: MARKET BUY 250 against asks 100.00x100, 100.01x200, 100.03x300', () => {
    const asks = [
      { price: 100.0, qty: 100 },
      { price: 100.01, qty: 200 },
      { price: 100.03, qty: 300 },
    ];
    const result = walkBook(asks, 'BUY', 250);
    expect(result.levelFills).toEqual([
      { price: 100.0, quantity: 100 },
      { price: 100.01, quantity: 150 },
    ]);
    expect(result.filledQuantity).toBe(250);

    const avg = averageFillPrice(result.levelFills);
    expect(avg).toBeCloseTo(100.006, 10);
    expect(slippagePct('BUY', avg!, 100.0)).toBeCloseTo(0.006, 10);

    const notional = result.levelFills.reduce((sum, f) => sum + notionalUsdt(f.quantity, f.price, 1), 0);
    const fee = feeUsdt(notional, 0.0005);
    expect(fee).toBeCloseTo(12.50075, 10);
  });

  it('SELL walks bids descending: 150 against 99.99x100, 99.98x100', () => {
    const bids = [
      { price: 99.99, qty: 100 },
      { price: 99.98, qty: 100 },
    ];
    const result = walkBook(bids, 'SELL', 150);
    expect(result.levelFills).toEqual([
      { price: 99.99, quantity: 100 },
      { price: 99.98, quantity: 50 },
    ]);
    const avg = averageFillPrice(result.levelFills);
    expect(avg).toBeCloseTo(99.98666666667, 9);
  });

  it('not best ask: requested quantity exceeds best level -> average strictly greater than best ask', () => {
    const asks = [
      { price: 100.0, qty: 10 },
      { price: 100.05, qty: 100 },
    ];
    const result = walkBook(asks, 'BUY', 50);
    const avg = averageFillPrice(result.levelFills)!;
    expect(avg).toBeGreaterThan(100.0);
  });

  it('LIMIT BUY only consumes levels at or below the limit price', () => {
    const asks = [
      { price: 100.0, qty: 100 },
      { price: 100.01, qty: 200 },
    ];
    const result = walkBook(asks, 'BUY', 250, 100.0);
    expect(result.levelFills).toEqual([{ price: 100.0, quantity: 100 }]);
    expect(result.filledQuantity).toBe(100);
  });

  it('empty book yields zero fills', () => {
    const result = walkBook([], 'BUY', 100);
    expect(result.levelFills).toEqual([]);
    expect(result.filledQuantity).toBe(0);
    expect(averageFillPrice(result.levelFills)).toBeUndefined();
  });
});

describe('slippagePct', () => {
  it('SELL: receiving less than reference is "worse" (positive)', () => {
    expect(slippagePct('SELL', 99.9, 100)).toBeCloseTo(0.1, 10);
  });
  it('BUY: paying more than reference is "worse" (positive)', () => {
    expect(slippagePct('BUY', 100.1, 100)).toBeCloseTo(0.1, 10);
  });
});

describe('isValidStep', () => {
  it('accepts an exact multiple of step size', () => {
    expect(isValidStep(0.3, 0.001)).toBe(true);
    expect(isValidStep(250, 1)).toBe(true);
  });
  it('rejects a non-multiple of step size', () => {
    expect(isValidStep(0.3005, 0.001)).toBe(false);
  });
});
