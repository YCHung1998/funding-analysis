import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, type EntryContext, type RiskConfig } from './types';
import { evaluateEntry } from './executionRisk';

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG };

const baseCtx: EntryContext = {
  now: 1_700_000_000_000,
  leg_mid_price: { long: 100, short: 100 },
  leg_target_entry_price: { long: 100, short: 100 },
  arm_funding_spread: 0.001,
  current_funding_spread: 0.001,
  order_timeout_occurred: false,
  hedge_state: 'HEDGED',
  hedge_ratio: 1,
  leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
  leg_recent_mid_prices: { long: [100, 100.1, 100.05], short: [100, 100.02, 99.98] },
};

function withCtx(overrides: Partial<EntryContext>): EntryContext {
  return { ...baseCtx, ...overrides };
}

describe('evaluateEntry — all PASS → CONTINUE', () => {
  it('passes every check', () => {
    const result = evaluateEntry(baseCtx, cfg);
    expect(result.items).toHaveLength(7);
    expect(result.items.every((i) => i.status === 'PASS')).toBe(true);
    expect(result.action).toBe('CONTINUE');
  });
});

describe('PRICE_DEVIATION', () => {
  it('FAILs on deviation > threshold', () => {
    const ctx = withCtx({
      leg_target_entry_price: { long: 100, short: 100 },
      leg_mid_price: { long: 100, short: 100.4 },
    });
    const localCfg = { ...cfg, max_entry_price_deviation_pct: 0.003 };
    const r = evaluateEntry(ctx, localCfg).items.find((i) => i.check_code === 'PRICE_DEVIATION')!;
    expect(r.status).toBe('FAIL');
    expect(r.action).toBe('HALT_ENTRY');
  });
});

describe('FUNDING_RATE_CHANGE', () => {
  it('FAILs when spread shrinks beyond tolerance', () => {
    const ctx = withCtx({ arm_funding_spread: 0.001, current_funding_spread: 0.0007 });
    const localCfg = { ...cfg, rate_change_tolerance: 0.0002 };
    const r = evaluateEntry(ctx, localCfg).items.find((i) => i.check_code === 'FUNDING_RATE_CHANGE')!;
    expect(r.status).toBe('FAIL');
  });

  it('PASSes on small shrink', () => {
    const ctx = withCtx({ arm_funding_spread: 0.001, current_funding_spread: 0.0009 });
    const r = evaluateEntry(ctx, cfg).items.find((i) => i.check_code === 'FUNDING_RATE_CHANGE')!;
    expect(r.status).toBe('PASS');
  });
});

describe('ORDER_TIMEOUT', () => {
  it('FAILs when an entry order timed out', () => {
    const ctx = withCtx({ order_timeout_occurred: true });
    const r = evaluateEntry(ctx, cfg).items.find((i) => i.check_code === 'ORDER_TIMEOUT')!;
    expect(r.status).toBe('FAIL');
    expect(r.action).toBe('HALT_ENTRY');
  });
});

describe('PARTIAL_FILL', () => {
  it('FAILs (EMERGENCY_EXIT) at/after timeout', () => {
    const ctx = withCtx({ hedge_state: 'PARTIALLY_HEDGED', partially_hedged_since: 0, now: 5000 });
    const localCfg = { ...cfg, partial_hedge_max_duration_ms: 5000 };
    const r = evaluateEntry(ctx, localCfg).items.find((i) => i.check_code === 'PARTIAL_FILL')!;
    expect(r.status).toBe('FAIL');
    expect(r.action).toBe('EMERGENCY_EXIT');
  });

  it('WARNs before timeout', () => {
    const ctx = withCtx({ hedge_state: 'PARTIALLY_HEDGED', partially_hedged_since: 0, now: 3000 });
    const localCfg = { ...cfg, partial_hedge_max_duration_ms: 5000 };
    const r = evaluateEntry(ctx, localCfg).items.find((i) => i.check_code === 'PARTIAL_FILL')!;
    expect(r.status).toBe('WARN');
    expect(r.value).toBe('3000ms');
  });
});

describe('LEG_IMBALANCE', () => {
  it('FAILs when one leg rejected (hedge_ratio=0)', () => {
    const ctx = withCtx({ hedge_ratio: 0, both_legs_zero_fill: false });
    const r = evaluateEntry(ctx, cfg).items.find((i) => i.check_code === 'LEG_IMBALANCE')!;
    expect(r.status).toBe('FAIL');
    expect(r.action).toBe('EMERGENCY_EXIT');
  });

  it('FAILs on partial fill below imbalance_below', () => {
    const ctx = withCtx({ hedge_ratio: 0.3 });
    const localCfg = { ...cfg, hedge_ratio_imbalance_below: 0.9 };
    const r = evaluateEntry(ctx, localCfg).items.find((i) => i.check_code === 'LEG_IMBALANCE')!;
    expect(r.status).toBe('FAIL');
  });

  it('PASSes when both legs zero fill (not imbalance)', () => {
    const ctx = withCtx({ hedge_ratio: 0, both_legs_zero_fill: true });
    const r = evaluateEntry(ctx, cfg).items.find((i) => i.check_code === 'LEG_IMBALANCE')!;
    expect(r.status).toBe('PASS');
  });
});

describe('EXCHANGE_CONNECTION', () => {
  it('FAILs on disconnect during entry', () => {
    const ctx = withCtx({ leg_connectivity: { long: 'DISCONNECTED', short: 'CONNECTED' } });
    const r = evaluateEntry(ctx, cfg).items.find((i) => i.check_code === 'EXCHANGE_CONNECTION')!;
    expect(r.status).toBe('FAIL');
    expect(r.action).toBe('HALT_ENTRY');
  });
});

describe('MARKET_VOLATILITY', () => {
  it('FAILs on sharp move within window', () => {
    const ctx = withCtx({ leg_recent_mid_prices: { long: [100, 100.1], short: [100.0, 100.6] } });
    const localCfg = { ...cfg, max_entry_volatility_pct: 0.005 };
    const r = evaluateEntry(ctx, localCfg).items.find((i) => i.check_code === 'MARKET_VOLATILITY')!;
    expect(r.status).toBe('FAIL');
  });

  it('INPUT_MISSING when fewer than 2 samples', () => {
    const ctx = withCtx({ leg_recent_mid_prices: { long: [100], short: [100, 100.1] } });
    const r = evaluateEntry(ctx, cfg).items.find((i) => i.check_code === 'MARKET_VOLATILITY')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('INPUT_MISSING');
  });
});

describe('action aggregation', () => {
  it('takes the most severe action among FAILs (EMERGENCY_EXIT > HALT_ENTRY)', () => {
    const ctx = withCtx({
      leg_target_entry_price: { long: 100, short: 100 },
      leg_mid_price: { long: 100, short: 100.4 }, // PRICE_DEVIATION -> HALT_ENTRY
      hedge_ratio: 0, // LEG_IMBALANCE -> EMERGENCY_EXIT
      both_legs_zero_fill: false,
    });
    const result = evaluateEntry(ctx, cfg);
    expect(result.action).toBe('EMERGENCY_EXIT');
    expect(result.leg_imbalance_detected).toBe(true);
  });
});
