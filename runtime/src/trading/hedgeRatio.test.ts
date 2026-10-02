/**
 * runtime/src/trading/hedgeRatio.test.ts
 *
 * Task 2.1/2.2 — computeHedgeRatio (NOTIONAL/QUANTITY switchable, default
 * QUANTITY per C-19), classifyHedge (boundaries 0.99/0.90, tier overrides),
 * and leg-imbalance measurement (design.md Decision 4/5, spec §14).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyHedge,
  computeHedgeRatio,
  DEFAULT_HEDGE_THRESHOLD,
  INITIAL_LEG_IMBALANCE_STATE,
  updateLegImbalance,
  type HedgeLegInput,
} from './hedgeRatio';

describe('computeHedgeRatio', () => {
  it('QUANTITY basis: equal base_quantity -> ratio 1.0 even with cross-exchange price difference (C-19 fixes false PARTIALLY_HEDGED)', () => {
    const long: HedgeLegInput = { base_quantity: 100, average_entry_price: 100 };
    const short: HedgeLegInput = { base_quantity: 100, average_entry_price: 100.5 };
    const result = computeHedgeRatio(long, short, 'QUANTITY');
    expect(result.quantity_ratio).toBe(1);
    expect(result.hedge_ratio).toBe(1);
    expect(result.basis).toBe('QUANTITY');
  });

  it('NOTIONAL basis: the same 0.5% cross-exchange price gap produces 0.995025 (would falsely read as PARTIALLY_HEDGED under NOTIONAL)', () => {
    const long: HedgeLegInput = { base_quantity: 100, average_entry_price: 100 };
    const short: HedgeLegInput = { base_quantity: 100, average_entry_price: 100.5 };
    const result = computeHedgeRatio(long, short, 'NOTIONAL');
    expect(result.notional_ratio).toBeCloseTo(0.995025, 6);
    expect(result.hedge_ratio).toBeCloseTo(0.995025, 6);
    // Both ratios are always returned regardless of selected basis (paper-execution-engine Decision 5).
    expect(result.quantity_ratio).toBe(1);
  });

  it('contract-multiplier case: raw contract quantities differ but converted base_quantity matches -> ratio 1.0', () => {
    // Long leg: 10 contracts x qty_unit_in_base 0.01 = 0.1 base units.
    // Short leg: 100 contracts x qty_unit_in_base 0.001 = 0.1 base units.
    // computeHedgeRatio only ever sees the already-converted base_quantity.
    const long: HedgeLegInput = { base_quantity: 10 * 0.01, average_entry_price: 50000 };
    const short: HedgeLegInput = { base_quantity: 100 * 0.001, average_entry_price: 50010 };
    const result = computeHedgeRatio(long, short, 'QUANTITY');
    expect(result.quantity_ratio).toBe(1);
  });

  it('a bare leg with the other at zero -> ratio 0 but has_exposure true', () => {
    const long: HedgeLegInput = { base_quantity: 100, average_entry_price: 100 };
    const short: HedgeLegInput = { base_quantity: 0, average_entry_price: 0 };
    const result = computeHedgeRatio(long, short, 'QUANTITY');
    expect(result.hedge_ratio).toBe(0);
    expect(result.has_exposure).toBe(true);
  });

  it('both legs empty -> ratio 0 and has_exposure false', () => {
    const empty: HedgeLegInput = { base_quantity: 0, average_entry_price: 0 };
    const result = computeHedgeRatio(empty, empty, 'QUANTITY');
    expect(result.hedge_ratio).toBe(0);
    expect(result.has_exposure).toBe(false);
  });
});

describe('classifyHedge', () => {
  it('ratio 0.99 (hedged_min) -> HEDGED', () => {
    expect(classifyHedge(0.99, 'BTCUSDT')).toBe('HEDGED');
  });
  it('ratio just under hedged_min -> PARTIALLY_HEDGED', () => {
    expect(classifyHedge(0.989999, 'BTCUSDT')).toBe('PARTIALLY_HEDGED');
  });
  it('ratio 0.90 (imbalance_max boundary) -> PARTIALLY_HEDGED (inclusive)', () => {
    expect(classifyHedge(0.9, 'BTCUSDT')).toBe('PARTIALLY_HEDGED');
  });
  it('ratio 0.30 -> LEG_IMBALANCE', () => {
    expect(classifyHedge(0.3, 'BTCUSDT')).toBe('LEG_IMBALANCE');
  });
  it('just under imbalance_max -> LEG_IMBALANCE', () => {
    expect(classifyHedge(0.899999, 'BTCUSDT')).toBe('LEG_IMBALANCE');
  });
  it('symbol tier override changes the classification (§14.3)', () => {
    const overrides = { DOGEUSDT: { hedged_min: 0.95, imbalance_max: 0.8 } };
    expect(classifyHedge(0.85, 'DOGEUSDT', overrides)).toBe('PARTIALLY_HEDGED');
    expect(classifyHedge(0.85, 'DOGEUSDT')).toBe('LEG_IMBALANCE'); // default thresholds, no override applied
  });
  it('DEFAULT_HEDGE_THRESHOLD matches spec §14 defaults', () => {
    expect(DEFAULT_HEDGE_THRESHOLD).toEqual({ hedged_min: 0.99, imbalance_max: 0.9 });
  });
});

describe('updateLegImbalance', () => {
  it('bare long leg for 800ms before the short leg fills -> max_leg_imbalance_usdt 1000 / duration 800ms', () => {
    const empty: HedgeLegInput = { base_quantity: 0, average_entry_price: 0 };
    const long: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 }; // notional 1000
    let state = INITIAL_LEG_IMBALANCE_STATE;

    state = updateLegImbalance(state, { timestamp: 0, long, short: empty, basis: 'QUANTITY', hedged_min: 0.99 });
    expect(state.max_leg_imbalance_usdt).toBe(1000);
    expect(state.max_leg_imbalance_duration_ms).toBe(0);

    state = updateLegImbalance(state, { timestamp: 500, long, short: empty, basis: 'QUANTITY', hedged_min: 0.99 });
    expect(state.max_leg_imbalance_duration_ms).toBe(500);

    // Short leg fills at t=800, fully balancing the position.
    const short: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 };
    state = updateLegImbalance(state, { timestamp: 800, long, short, basis: 'QUANTITY', hedged_min: 0.99 });

    expect(state.max_leg_imbalance_usdt).toBe(1000);
    expect(state.max_leg_imbalance_duration_ms).toBe(800);
    expect(state.current_interval_start_ms).toBeUndefined();
  });

  it('emergency-exit scenario: imbalance persists 5200ms until the bare leg is flattened', () => {
    const empty: HedgeLegInput = { base_quantity: 0, average_entry_price: 0 };
    const long: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 };
    let state = INITIAL_LEG_IMBALANCE_STATE;

    state = updateLegImbalance(state, { timestamp: 0, long, short: empty, basis: 'QUANTITY', hedged_min: 0.99 });
    state = updateLegImbalance(state, { timestamp: 3000, long, short: empty, basis: 'QUANTITY', hedged_min: 0.99 });
    // Emergency close flattens the long leg at t=5200 (both legs now empty).
    state = updateLegImbalance(state, { timestamp: 5200, long: empty, short: empty, basis: 'QUANTITY', hedged_min: 0.99 });

    expect(state.max_leg_imbalance_usdt).toBe(1000);
    expect(state.max_leg_imbalance_duration_ms).toBe(5200);
    expect(state.current_interval_start_ms).toBeUndefined();
  });

  it('never imbalanced -> duration stays 0', () => {
    const long: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 };
    const short: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 };
    let state = INITIAL_LEG_IMBALANCE_STATE;
    state = updateLegImbalance(state, { timestamp: 0, long, short, basis: 'QUANTITY', hedged_min: 0.99 });
    state = updateLegImbalance(state, { timestamp: 1000, long, short, basis: 'QUANTITY', hedged_min: 0.99 });
    expect(state.max_leg_imbalance_duration_ms).toBe(0);
    expect(state.max_leg_imbalance_usdt).toBe(0);
  });
});
