import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, type PositionContext } from './types';
import { evaluatePosition } from './positionRisk';

/**
 * Generative fail-open sweep for `PositionContext` (integrator review
 * follow-up — same approach as `missingInputEntry.test.ts`). Generated from
 * `Object.keys(base)` so a newly added `PositionContext` field is
 * automatically covered.
 */
const base: PositionContext = {
  now: 1_700_000_600_000,
  hedge_ratio: 1,
  leg_unrealized_loss_usdt: { long: 0, short: 0 },
  leg_margin_allocated_usdt: { long: 200, short: 200 },
  basis_now: 0.001,
  basis_at_entry: 0.001,
  hedged_by: 1_700_000_700_000,
  expected_funding_cashflow_usdt: 2,
  estimated_exit_cost_usdt: 1,
  entry_completed_at: 1_700_000_000_000,
};

const cfg = { ...DEFAULT_RISK_CONFIG };

describe('fail-open sweep: PositionContext missing/invalid inputs never CONTINUE', () => {
  it('sanity: base context is all-PASS/CONTINUE', () => {
    expect(evaluatePosition(base, cfg).action).toBe('CONTINUE');
  });

  for (const key of Object.keys(base) as (keyof PositionContext)[]) {
    it(`top-level ${key} = undefined → not CONTINUE`, () => {
      const ctx = { ...base, [key]: undefined } as unknown as PositionContext;
      expect(evaluatePosition(ctx, cfg).action).not.toBe('CONTINUE');
    });
  }

  const numericTop = Object.entries(base)
    .filter(([, v]) => typeof v === 'number')
    .map(([k]) => k);
  for (const key of numericTop) {
    it(`top-level ${key} = NaN → not CONTINUE`, () => {
      const ctx = { ...base, [key]: Number.NaN } as unknown as PositionContext;
      expect(evaluatePosition(ctx, cfg).action).not.toBe('CONTINUE');
    });
    it(`top-level ${key} = Infinity → not CONTINUE`, () => {
      const ctx = { ...base, [key]: Number.POSITIVE_INFINITY } as unknown as PositionContext;
      expect(evaluatePosition(ctx, cfg).action).not.toBe('CONTINUE');
    });
  }

  for (const key of ['leg_unrealized_loss_usdt', 'leg_margin_allocated_usdt'] as const) {
    it(`${key}.short = NaN → not CONTINUE`, () => {
      const ctx = { ...base, [key]: { ...base[key], short: Number.NaN } } as unknown as PositionContext;
      expect(evaluatePosition(ctx, cfg).action).not.toBe('CONTINUE');
    });
    it(`${key}.short = undefined → not CONTINUE`, () => {
      const ctx = { ...base, [key]: { ...base[key], short: undefined } } as unknown as PositionContext;
      expect(evaluatePosition(ctx, cfg).action).not.toBe('CONTINUE');
    });
  }

  it('EXIT_PENDING (exit_pending_since set) with both_legs_closed = undefined → not CONTINUE', () => {
    const ctx: PositionContext = { ...base, exit_pending_since: base.now - 1000, both_legs_closed: undefined };
    expect(evaluatePosition(ctx, cfg).action).not.toBe('CONTINUE');
  });

  it('EXIT_PENDING with exit_pending_since = NaN → not CONTINUE', () => {
    const ctx: PositionContext = { ...base, exit_pending_since: Number.NaN, both_legs_closed: false };
    expect(evaluatePosition(ctx, cfg).action).not.toBe('CONTINUE');
  });

  it('exit_pending_since absent entirely legitimately PASSes (not in EXIT_PENDING)', () => {
    const ctx: PositionContext = { ...base, exit_pending_since: undefined };
    expect(evaluatePosition(ctx, cfg).action).toBe('CONTINUE');
  });

  it('same input twice → identical items (determinism)', () => {
    expect(evaluatePosition(base, cfg)).toEqual(evaluatePosition(base, cfg));
  });
});
