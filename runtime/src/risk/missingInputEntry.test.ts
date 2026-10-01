import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, type EntryContext } from './types';
import { evaluateEntry } from './executionRisk';

/**
 * Generative fail-open sweep for `EntryContext` (integrator review
 * follow-up: the same `undefined`/`NaN`/empty-array probe that found the
 * Pre-Trade bug, applied to Entry). Generated from `Object.keys(base)` so a
 * newly added `EntryContext` field is automatically covered by future runs
 * — no test author needs to remember to add a case for it.
 */
const base: EntryContext = {
  now: 1_700_000_000_000,
  leg_mid_price: { long: 100, short: 100 },
  leg_target_entry_price: { long: 100, short: 100 },
  arm_funding_spread: 0.001,
  current_funding_spread: 0.001,
  order_timeout_occurred: false,
  hedge_state: 'HEDGED',
  hedge_ratio: 1,
  leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
  leg_recent_mid_prices: { long: [100, 100.1], short: [100, 99.98] },
};

const cfg = { ...DEFAULT_RISK_CONFIG };

// Fields whose absence/NaN legitimately keeps the stage CONTINUE:
// - `partially_hedged_since`/`both_legs_zero_fill` are conditionally required
//   (only read once `hedge_state === 'PARTIALLY_HEDGED'` / when not zero-fill)
//   and are not present in this HEDGED baseline at all.
const optionalKeys = new Set<string>([]);

describe('fail-open sweep: EntryContext missing/invalid inputs never CONTINUE', () => {
  it('sanity: base context is all-PASS/CONTINUE', () => {
    const result = evaluateEntry(base, cfg);
    expect(result.action).toBe('CONTINUE');
  });

  for (const key of Object.keys(base) as (keyof EntryContext)[]) {
    if (optionalKeys.has(key)) continue;
    it(`top-level ${key} = undefined → not CONTINUE`, () => {
      const ctx = { ...base, [key]: undefined } as unknown as EntryContext;
      expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
    });
  }

  const numericTop = Object.entries(base)
    .filter(([, v]) => typeof v === 'number')
    .map(([k]) => k);
  for (const key of numericTop) {
    it(`top-level ${key} = NaN → not CONTINUE`, () => {
      const ctx = { ...base, [key]: Number.NaN } as unknown as EntryContext;
      expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
    });
    it(`top-level ${key} = Infinity → not CONTINUE`, () => {
      const ctx = { ...base, [key]: Number.POSITIVE_INFINITY } as unknown as EntryContext;
      expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
    });
  }

  for (const key of ['leg_mid_price', 'leg_target_entry_price', 'leg_recent_mid_prices'] as const) {
    it(`${key}.short = NaN → not CONTINUE`, () => {
      const current = base[key] as Record<string, unknown>;
      const value = Array.isArray(current.short) ? [Number.NaN, 100] : Number.NaN;
      const ctx = { ...base, [key]: { ...current, short: value } } as unknown as EntryContext;
      expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
    });
    it(`${key}.short = undefined → not CONTINUE`, () => {
      const ctx = { ...base, [key]: { ...(base[key] as object), short: undefined } } as unknown as EntryContext;
      expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
    });
  }

  it('leg_connectivity.short = undefined → not CONTINUE', () => {
    const ctx = { ...base, leg_connectivity: { long: 'CONNECTED', short: undefined } } as unknown as EntryContext;
    expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
  });

  it('empty leg_recent_mid_prices.short → not CONTINUE', () => {
    const ctx = { ...base, leg_recent_mid_prices: { long: [100, 100.1], short: [] } };
    expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
  });

  it('single-sample leg_recent_mid_prices.short (< 2) → not CONTINUE', () => {
    const ctx = { ...base, leg_recent_mid_prices: { long: [100, 100.1], short: [100] } };
    expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
  });

  it('PARTIALLY_HEDGED with partially_hedged_since = NaN → not CONTINUE', () => {
    const ctx: EntryContext = { ...base, hedge_state: 'PARTIALLY_HEDGED', partially_hedged_since: Number.NaN };
    expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
  });

  it('PARTIALLY_HEDGED with partially_hedged_since = undefined → not CONTINUE', () => {
    const ctx: EntryContext = { ...base, hedge_state: 'PARTIALLY_HEDGED' };
    expect(evaluateEntry(ctx, cfg).action).not.toBe('CONTINUE');
  });

  it('same input twice → identical items (determinism)', () => {
    expect(evaluateEntry(base, cfg)).toEqual(evaluateEntry(base, cfg));
  });
});
