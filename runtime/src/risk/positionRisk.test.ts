import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, type PositionContext, type RiskConfig } from './types';
import { evaluatePosition } from './positionRisk';

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG };

const baseCtx: PositionContext = {
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

function withCtx(overrides: Partial<PositionContext>): PositionContext {
  return { ...baseCtx, ...overrides };
}

describe('evaluatePosition — all PASS → CONTINUE', () => {
  it('passes every check', () => {
    const result = evaluatePosition(baseCtx, cfg);
    expect(result.items).toHaveLength(6);
    expect(result.items.every((i) => i.status === 'PASS')).toBe(true);
    expect(result.action).toBe('CONTINUE');
  });
});

describe('POSITION_IMBALANCE', () => {
  it('FAILs below imbalance_below', () => {
    const ctx = withCtx({ hedge_ratio: 0.85 });
    const localCfg = { ...cfg, hedge_ratio_imbalance_below: 0.9 };
    const r = evaluatePosition(ctx, localCfg).items.find((i) => i.check_code === 'POSITION_IMBALANCE')!;
    expect(r.status).toBe('FAIL');
    expect(r.action).toBe('EMERGENCY_EXIT');
  });

  it('WARNs between imbalance_below and hedged_min', () => {
    const ctx = withCtx({ hedge_ratio: 0.95 });
    const localCfg = { ...cfg, hedge_ratio_imbalance_below: 0.9, hedge_ratio_hedged_min: 0.99 };
    const r = evaluatePosition(ctx, localCfg).items.find((i) => i.check_code === 'POSITION_IMBALANCE')!;
    expect(r.status).toBe('WARN');
  });
});

describe('MARK_PRICE_MOVEMENT', () => {
  it('FAILs when unrealized loss ratio reaches threshold', () => {
    const ctx = withCtx({
      leg_unrealized_loss_usdt: { long: 0, short: 100 },
      leg_margin_allocated_usdt: { long: 200, short: 200 },
    });
    const localCfg = { ...cfg, max_leg_margin_loss_ratio: 0.5 };
    const r = evaluatePosition(ctx, localCfg).items.find((i) => i.check_code === 'MARK_PRICE_MOVEMENT')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('MARK_PRICE_ADVERSE');
  });
});

describe('BASIS_DIVERGENCE', () => {
  it('FAILs when basis expands beyond threshold', () => {
    const ctx = withCtx({ basis_at_entry: 0.001, basis_now: 0.007 });
    const localCfg = { ...cfg, max_basis_divergence_pct: 0.005 };
    const r = evaluatePosition(ctx, localCfg).items.find((i) => i.check_code === 'BASIS_DIVERGENCE')!;
    expect(r.status).toBe('FAIL');
  });

  it('WARNs on moderate divergence', () => {
    const ctx = withCtx({ basis_at_entry: 0.001, basis_now: 0.004 });
    const localCfg = { ...cfg, max_basis_divergence_pct: 0.005 };
    const r = evaluatePosition(ctx, localCfg).items.find((i) => i.check_code === 'BASIS_DIVERGENCE')!;
    expect(r.status).toBe('WARN');
  });
});

describe('FUNDING_CHANGE', () => {
  it('FAILs before hedged_by when flip exceeds exit cost', () => {
    const ctx = withCtx({ hedged_by: 1_700_000_015_000, now: 1_700_000_000_000, expected_funding_cashflow_usdt: -1.5, estimated_exit_cost_usdt: 1.0 });
    const r = evaluatePosition(ctx, cfg).items.find((i) => i.check_code === 'FUNDING_CHANGE')!;
    expect(r.status).toBe('FAIL');
    expect(r.action).toBe('EMERGENCY_EXIT');
  });

  it('WARNs (not EMERGENCY_EXIT) once in lock window', () => {
    const ctx = withCtx({ hedged_by: 1_700_000_005_000, now: 1_700_000_010_000, expected_funding_cashflow_usdt: -1.5, estimated_exit_cost_usdt: 1.0 });
    const result = evaluatePosition(ctx, cfg);
    const r = result.items.find((i) => i.check_code === 'FUNDING_CHANGE')!;
    expect(r.status).toBe('WARN');
    expect(result.action).toBe('CONTINUE');
  });
});

describe('HOLDING_TIME', () => {
  it('FAILs after max holding time', () => {
    const ctx = withCtx({ entry_completed_at: 0, now: 600_001 });
    const localCfg = { ...cfg, max_holding_time_ms: 600_000 };
    const r = evaluatePosition(ctx, localCfg).items.find((i) => i.check_code === 'HOLDING_TIME')!;
    expect(r.status).toBe('FAIL');
  });
});

describe('EXIT_CONDITION', () => {
  it('FAILs when EXIT_PENDING stalls beyond timeout', () => {
    const ctx = withCtx({ exit_pending_since: 30_000, now: 35_001, both_legs_closed: false });
    const localCfg = { ...cfg, emergency_exit_timeout_ms: 5000 };
    const r = evaluatePosition(ctx, localCfg).items.find((i) => i.check_code === 'EXIT_CONDITION')!;
    expect(r.status).toBe('FAIL');
  });

  it('PASSes when not in EXIT_PENDING', () => {
    const ctx = withCtx({ exit_pending_since: undefined });
    const r = evaluatePosition(ctx, cfg).items.find((i) => i.check_code === 'EXIT_CONDITION')!;
    expect(r.status).toBe('PASS');
  });
});

describe('aggregation', () => {
  it('any FAIL → EMERGENCY_EXIT', () => {
    const ctx = withCtx({ hedge_ratio: 0.5 });
    const result = evaluatePosition(ctx, cfg);
    expect(result.action).toBe('EMERGENCY_EXIT');
    expect(result.leg_imbalance_detected).toBe(true);
  });
});
