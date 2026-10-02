/**
 * runtime/src/trading/hedgeRatioEvent.test.ts
 *
 * Task 3.1 — hedge_ratio_basis switching, symbol_tier_overrides,
 * HEDGE_RATIO_CHANGED payload (spec "Hedge ratio behaviour with switchable
 * basis", §13 examples, basis-switch example).
 */
import { describe, expect, it } from 'vitest';
import type { HedgeLegInput } from './hedgeRatio';
import {
  buildHedgeRatioChangedEvent,
  DEFAULT_HEDGE_RATIO_BASIS,
  evaluateHedgeRatio,
  resolveHedgeThreshold,
  type HedgeRatioConfig,
} from './hedgeRatioEvent';

const clock = { now: () => 1000 };

describe('DEFAULT_HEDGE_RATIO_BASIS', () => {
  it('is QUANTITY per C-19 (2026-10-02), not spec.md-literal NOTIONAL', () => {
    expect(DEFAULT_HEDGE_RATIO_BASIS).toBe('QUANTITY');
  });
});

describe('evaluateHedgeRatio — spec §13 examples (basis NOTIONAL)', () => {
  const long: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 }; // notional 1000
  const config: HedgeRatioConfig = { hedge_ratio_basis: 'NOTIONAL' };

  it('short notional 300 -> LEG_IMBALANCE (ratio 0.30)', () => {
    const short: HedgeLegInput = { base_quantity: 3, average_entry_price: 100 }; // notional 300
    const { classification, result } = evaluateHedgeRatio({ symbol: 'BTCUSDT', long, short, config });
    expect(result.hedge_ratio).toBeCloseTo(0.3, 9);
    expect(classification).toBe('LEG_IMBALANCE');
  });

  it('short notional 950 -> PARTIALLY_HEDGED (ratio 0.95)', () => {
    const short: HedgeLegInput = { base_quantity: 9.5, average_entry_price: 100 }; // notional 950
    const { classification, result } = evaluateHedgeRatio({ symbol: 'BTCUSDT', long, short, config });
    expect(result.hedge_ratio).toBeCloseTo(0.95, 9);
    expect(classification).toBe('PARTIALLY_HEDGED');
  });

  it('short notional 995 -> HEDGED (ratio 0.995)', () => {
    const short: HedgeLegInput = { base_quantity: 9.95, average_entry_price: 100 }; // notional 995
    const { classification, result } = evaluateHedgeRatio({ symbol: 'BTCUSDT', long, short, config });
    expect(result.hedge_ratio).toBeCloseTo(0.995, 9);
    expect(classification).toBe('HEDGED');
  });
});

describe('evaluateHedgeRatio — basis switch changes outcome', () => {
  const long: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 }; // notional 1000
  const short: HedgeLegInput = { base_quantity: 10, average_entry_price: 101.2 }; // notional 1012

  it('NOTIONAL -> PARTIALLY_HEDGED (ratio 0.98814...)', () => {
    const { classification, result } = evaluateHedgeRatio({
      symbol: 'BTCUSDT',
      long,
      short,
      config: { hedge_ratio_basis: 'NOTIONAL' },
    });
    expect(result.hedge_ratio).toBeCloseTo(1000 / 1012, 6);
    expect(classification).toBe('PARTIALLY_HEDGED');
    // Both ratios are always carried regardless of selected basis.
    expect(result.quantity_ratio).toBe(1);
  });

  it('QUANTITY -> HEDGED (ratio 1.0)', () => {
    const { classification, result } = evaluateHedgeRatio({
      symbol: 'BTCUSDT',
      long,
      short,
      config: { hedge_ratio_basis: 'QUANTITY' },
    });
    expect(result.hedge_ratio).toBe(1);
    expect(classification).toBe('HEDGED');
    expect(result.notional_ratio).toBeCloseTo(1000 / 1012, 6);
  });

  it('default config (no hedge_ratio_basis given) resolves to QUANTITY -> HEDGED', () => {
    const { classification } = evaluateHedgeRatio({ symbol: 'BTCUSDT', long, short, config: {} });
    expect(classification).toBe('HEDGED');
  });
});

describe('resolveHedgeThreshold — symbol_tier_overrides', () => {
  it('uses the override when present for the symbol', () => {
    const config: HedgeRatioConfig = { symbol_tier_overrides: { DOGEUSDT: { hedged_min: 0.95, imbalance_max: 0.8 } } };
    expect(resolveHedgeThreshold('DOGEUSDT', config)).toEqual({ hedged_min: 0.95, imbalance_max: 0.8 });
  });

  it('falls back to config-level defaults, then spec defaults, when no override matches', () => {
    expect(resolveHedgeThreshold('BTCUSDT', { symbol_tier_overrides: { DOGEUSDT: { hedged_min: 0.95, imbalance_max: 0.8 } } })).toEqual(
      { hedged_min: 0.99, imbalance_max: 0.9 },
    );
    expect(resolveHedgeThreshold('BTCUSDT', { hedge_ratio_hedged_min: 0.97, hedge_ratio_imbalance_below: 0.85 })).toEqual({
      hedged_min: 0.97,
      imbalance_max: 0.85,
    });
  });

  it('symbol tier override changes classification outcome end-to-end', () => {
    const long: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 };
    const short: HedgeLegInput = { base_quantity: 8.5, average_entry_price: 100 }; // ratio 0.85
    const withOverride = evaluateHedgeRatio({
      symbol: 'DOGEUSDT',
      long,
      short,
      config: { hedge_ratio_basis: 'NOTIONAL', symbol_tier_overrides: { DOGEUSDT: { hedged_min: 0.95, imbalance_max: 0.8 } } },
    });
    expect(withOverride.classification).toBe('PARTIALLY_HEDGED');

    const withoutOverride = evaluateHedgeRatio({ symbol: 'DOGEUSDT', long, short, config: { hedge_ratio_basis: 'NOTIONAL' } });
    expect(withoutOverride.classification).toBe('LEG_IMBALANCE');
  });
});

describe('buildHedgeRatioChangedEvent', () => {
  it('records both ratios, basis, long_value, short_value', () => {
    const long: HedgeLegInput = { base_quantity: 10, average_entry_price: 100 };
    const short: HedgeLegInput = { base_quantity: 10, average_entry_price: 101.2 };
    const { result } = evaluateHedgeRatio({ symbol: 'BTCUSDT', long, short, config: { hedge_ratio_basis: 'QUANTITY' } });
    const event = buildHedgeRatioChangedEvent({ trade_id: 'trade1', symbol: 'BTCUSDT', result }, clock);

    expect(event.event_type).toBe('HEDGE_RATIO_CHANGED');
    expect(event.trade_id).toBe('trade1');
    expect(event.timestamp).toBe(1000);
    expect(event.payload).toEqual({
      ratio: 1,
      basis: 'QUANTITY',
      notional_ratio: result.notional_ratio,
      quantity_ratio: 1,
      long_value: 10,
      short_value: 10,
    });
  });
});
