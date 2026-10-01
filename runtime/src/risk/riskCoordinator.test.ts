import { describe, expect, it, vi } from 'vitest';
import type { RiskCheck } from '../types';
import {
  EntryRiskMonitor,
  PositionRiskMonitor,
  runArmPreTradeRisk,
  runPreFlightRisk,
  type ExecutionCommandPort,
  type RiskCoordinatorDeps,
} from './riskCoordinator';
import { DEFAULT_RISK_CONFIG, type EntryContext, type PreTradeContext, type RiskConfig } from './types';

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG };

function makeDeps(): RiskCoordinatorDeps & { events: unknown[]; rows: RiskCheck[] } {
  const events: unknown[] = [];
  const rows: RiskCheck[] = [];
  let seq = 0;
  return {
    capital: { reserve: vi.fn(), release: vi.fn() },
    eventSink: { emit: (e) => events.push(e) },
    checkSink: { record: (r) => rows.push(...r) },
    idGenerator: () => `id-${seq++}`,
    events,
    rows,
  };
}

const allPassCtx: PreTradeContext = {
  now: 1_700_000_000_000,
  required_capital_usdt: 100,
  available_capital_usdt: 9000,
  non_terminal_trade_count: 0,
  target_notional_per_leg_usdt: 500,
  leverage: 3,
  leg_max_leverage: { long: 10, short: 10 },
  long_funding_rate: 0.0001,
  short_funding_rate: 0.001,
  estimated_net_pnl_usdt: 5,
  leg_estimated_slippage_pct: { long: 0.0003, short: 0.0004 },
  leg_depth_usdt: { long: 5000, short: 5000 },
  leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
  leg_instrument_status: { long: 'TRADING', short: 'TRADING' },
  leg_api_latency_samples_ms: { long: [50, 60, 70], short: [40, 50, 60] },
  funding_time_eligible: true,
  entry_deadline: 1_700_000_100_000,
  same_symbol_existing_exposure: false,
  leg_exchange_existing_notional_usdt: { long: 0, short: 0 },
  data_age_samples: [{ name: 'orderbook', ageMs: 500 }],
  leg_clock_offset: {
    long: { errorMs: 100, calibratedAt: 1_699_999_990_000 },
    short: { errorMs: 100, calibratedAt: 1_699_999_990_000 },
  },
  entry_gate_sources: {},
};

describe('runArmPreTradeRisk', () => {
  it('ALLOW → SELECTED, reserves capital, writes 15 rows, STARTED+PASSED events', () => {
    const deps = makeDeps();
    const outcome = runArmPreTradeRisk(
      { opportunity_id: 'opp-1', ctx: allPassCtx, cfg, required_capital_usdt: 454, trade_id: 'trade-1' },
      deps,
    );
    expect(outcome.outcome).toBe('SELECTED');
    expect(deps.capital.reserve).toHaveBeenCalledWith('trade-1', 454);
    expect(deps.rows).toHaveLength(15);
    expect(deps.events.map((e: any) => e.event_type)).toEqual(['RISK_CHECK_STARTED', 'RISK_CHECK_PASSED']);
  });

  it('BLOCK → REJECTED, does not reserve capital, rejection_reason = first FAIL (spec scenario)', () => {
    const deps = makeDeps();
    const ctx = { ...allPassCtx, required_capital_usdt: 99999, data_age_samples: [{ name: 'x', ageMs: 99999 }] };
    const outcome = runArmPreTradeRisk(
      { opportunity_id: 'opp-1', ctx, cfg, required_capital_usdt: 99999, trade_id: 'trade-1' },
      deps,
    );
    expect(outcome.outcome).toBe('REJECTED');
    if (outcome.outcome === 'REJECTED') {
      expect(outcome.rejection_reason).toBe('INSUFFICIENT_CAPITAL'); // CAPITAL precedes DATA_FRESHNESS in registry order
    }
    expect(deps.capital.reserve).not.toHaveBeenCalled();
    expect(deps.events.map((e: any) => e.event_type)).toEqual(['RISK_CHECK_STARTED', 'RISK_CHECK_FAILED']);
  });
});

describe('runPreFlightRisk', () => {
  it('CONTINUE on all 6 ★ checks passing', () => {
    const deps = makeDeps();
    const outcome = runPreFlightRisk({ opportunity_id: 'opp-1', trade_id: 'trade-1', ctx: allPassCtx, cfg }, deps);
    expect(outcome.outcome).toBe('CONTINUE');
    expect(deps.capital.release).not.toHaveBeenCalled();
    expect(deps.rows).toHaveLength(6);
  });

  it('ABORTED + releases capital when data is stale at PRE_FLIGHT (spec scenario)', () => {
    const deps = makeDeps();
    const ctx = { ...allPassCtx, data_age_samples: [{ name: 'long_mid', ageMs: 4000 }] };
    const localCfg = { ...cfg, data_stale_threshold_ms: 2000 };
    const outcome = runPreFlightRisk({ opportunity_id: 'opp-1', trade_id: 'trade-1', ctx, cfg: localCfg }, deps);
    expect(outcome.outcome).toBe('ABORTED');
    if (outcome.outcome === 'ABORTED') expect(outcome.reason).toBe('STALE_MARKET_DATA');
    expect(deps.capital.release).toHaveBeenCalledWith('trade-1', 'STALE_MARKET_DATA');
  });
});

function makeExecution(): ExecutionCommandPort & {
  cancelled: string[];
  rejected: string[];
  emergencyExits: string[];
} {
  const cancelled: string[] = [];
  const rejected: string[] = [];
  const emergencyExits: string[] = [];
  return {
    cancelEntryOrders: (tradeId) => cancelled.push(tradeId),
    rejectFurtherEntry: (tradeId) => rejected.push(tradeId),
    startEmergencyExit: (tradeId) => emergencyExits.push(tradeId),
    cancelled,
    rejected,
    emergencyExits,
  };
}

const baseEntryCtx: EntryContext = {
  now: 0,
  leg_mid_price: { long: 100, short: 100 },
  leg_target_entry_price: { long: 100, short: 100 },
  arm_funding_spread: 0.001,
  current_funding_spread: 0.001,
  order_timeout_occurred: false,
  hedge_state: 'ENTRY_PENDING' as never,
  hedge_ratio: 1,
  leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
  leg_recent_mid_prices: { long: [100, 100.01], short: [100, 100.01] },
};

describe('EntryRiskMonitor', () => {
  it('spec scenario: HALT_ENTRY triggers cancelEntryOrders + rejectFurtherEntry for subsequent requests', () => {
    const deps = makeDeps();
    const execution = makeExecution();
    const monitor = new EntryRiskMonitor('opp-1', 'trade-1', deps, execution);
    const ctx = { ...baseEntryCtx, leg_mid_price: { long: 100, short: 100.4 } }; // PRICE_DEVIATION -> HALT_ENTRY
    const result = monitor.start(ctx, cfg);
    expect(result.action).toBe('HALT_ENTRY');
    expect(execution.cancelled).toEqual(['trade-1']);
    expect(execution.rejected).toEqual(['trade-1']);
  });

  it('S10-style: 20 ticks, only the 12th flips a status → 7 (start) + 1 (change) + 7 (end) = 15 rows', () => {
    const deps = makeDeps();
    const execution = makeExecution();
    const monitor = new EntryRiskMonitor('opp-1', 'trade-1', deps, execution);

    monitor.start(baseEntryCtx, cfg); // writes 7
    for (let i = 0; i < 18; i++) {
      const deviated = i >= 10; // from the 12th overall call onward (start + 10 continues)
      const ctx = { ...baseEntryCtx, leg_mid_price: { long: 100, short: deviated ? 100.4 : 100 } };
      monitor.continue(ctx, cfg); // writes 1 the first time it flips, 0 thereafter
    }
    monitor.end({ ...baseEntryCtx, leg_mid_price: { long: 100, short: 100.4 } }, cfg); // writes 7

    expect(deps.rows).toHaveLength(15);
  });

  it('LEG_IMBALANCE requests emergency exit via startEmergencyExit', () => {
    const deps = makeDeps();
    const execution = makeExecution();
    const monitor = new EntryRiskMonitor('opp-1', 'trade-1', deps, execution);
    const ctx = { ...baseEntryCtx, hedge_ratio: 0, both_legs_zero_fill: false };
    monitor.start(ctx, cfg);
    expect(execution.emergencyExits).toEqual(['trade-1']);
  });
});

const basePositionCtx = {
  now: 0,
  hedge_ratio: 1,
  leg_unrealized_loss_usdt: { long: 0, short: 0 },
  leg_margin_allocated_usdt: { long: 200, short: 200 },
  basis_now: 0.001,
  basis_at_entry: 0.001,
  hedged_by: 100_000,
  expected_funding_cashflow_usdt: 2,
  estimated_exit_cost_usdt: 1,
  entry_completed_at: 0,
};

describe('PositionRiskMonitor', () => {
  it('HEDGED FAIL requests emergency exit and emits RISK_CHECK_FAILED', () => {
    const deps = makeDeps();
    const execution = makeExecution();
    const monitor = new PositionRiskMonitor('opp-1', 'trade-1', deps, execution);
    const ctx = { ...basePositionCtx, hedge_ratio: 0.5 };
    const result = monitor.start(ctx, cfg);
    expect(result.action).toBe('EMERGENCY_EXIT');
    expect(execution.emergencyExits).toEqual(['trade-1']);
    expect(deps.events.some((e: any) => e.event_type === 'RISK_CHECK_FAILED')).toBe(true);
  });
});
