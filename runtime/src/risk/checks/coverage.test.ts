/**
 * runtime/src/risk/checks/coverage.test.ts
 *
 * "每一個檢查項目都有 FAIL 測試" (spec.md): a single scenario table — one
 * FAIL-producing context and one INPUT_MISSING-producing context per
 * `check_code` — is exercised against the real evaluators. If a new
 * `check_code` is added to the registry without a matching table entry here,
 * this test fails and names the missing code (solves HANDOFF P7's "r5 / r7
 * / r9 always PASS" by making "no FAIL test" a hard build failure, not a
 * silent gap).
 */
import { describe, expect, it } from 'vitest';
import { ALL_CHECKS } from './registry';
import { DEFAULT_RISK_CONFIG, type EntryContext, type PositionContext, type PreTradeContext, type RiskConfig } from '../types';
import { evaluatePreTrade } from '../preTradeRisk';
import { evaluateEntry } from '../executionRisk';
import { evaluatePosition } from '../positionRisk';

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG };

const validPreTrade: PreTradeContext = {
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

const validEntry: EntryContext = {
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

const validPosition: PositionContext = {
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

interface ScenarioEntry {
  failCtx: () => PreTradeContext | EntryContext | PositionContext;
  missingField: keyof PreTradeContext | keyof EntryContext | keyof PositionContext;
}

const PRE_TRADE_SCENARIOS: Record<string, ScenarioEntry> = {
  CAPITAL: { failCtx: () => ({ ...validPreTrade, required_capital_usdt: 9999 }), missingField: 'required_capital_usdt' },
  MAX_POSITIONS: {
    failCtx: () => ({ ...validPreTrade, non_terminal_trade_count: cfg.max_positions }),
    missingField: 'non_terminal_trade_count',
  },
  MAX_NOTIONAL_PER_LEG: {
    failCtx: () => ({ ...validPreTrade, target_notional_per_leg_usdt: cfg.max_notional_per_leg_usdt + 1 }),
    missingField: 'target_notional_per_leg_usdt',
  },
  MAX_LEVERAGE: { failCtx: () => ({ ...validPreTrade, leverage: cfg.max_leverage + 1 }), missingField: 'leverage' },
  MIN_FUNDING_SPREAD: {
    failCtx: () => ({ ...validPreTrade, long_funding_rate: 0.001, short_funding_rate: 0.0001 }),
    missingField: 'long_funding_rate',
  },
  EXPECTED_NET_PNL: {
    failCtx: () => ({ ...validPreTrade, estimated_net_pnl_usdt: cfg.minimum_expected_net_pnl_usdt - 1 }),
    missingField: 'estimated_net_pnl_usdt',
  },
  MAX_SLIPPAGE: {
    failCtx: () => ({ ...validPreTrade, leg_estimated_slippage_pct: { long: 0.0001, short: cfg.max_slippage_pct + 0.001 } }),
    missingField: 'leg_estimated_slippage_pct',
  },
  ORDERBOOK_DEPTH: {
    failCtx: () => ({ ...validPreTrade, leg_depth_usdt: { long: 5000, short: 1 } }),
    missingField: 'leg_depth_usdt',
  },
  EXCHANGE_CONNECTIVITY: {
    failCtx: () => ({ ...validPreTrade, leg_connectivity: { long: 'CONNECTED', short: 'DISCONNECTED' } }),
    missingField: 'leg_connectivity',
  },
  API_LATENCY: {
    failCtx: () => ({ ...validPreTrade, leg_api_latency_samples_ms: { long: [999], short: [10] } }),
    missingField: 'leg_api_latency_samples_ms',
  },
  FUNDING_TIME_ALIGNMENT: { failCtx: () => ({ ...validPreTrade, funding_time_eligible: false }), missingField: 'funding_time_eligible' },
  EXISTING_EXPOSURE: { failCtx: () => ({ ...validPreTrade, same_symbol_existing_exposure: true }), missingField: 'same_symbol_existing_exposure' },
  DATA_FRESHNESS: {
    failCtx: () => ({ ...validPreTrade, data_age_samples: [{ name: 'x', ageMs: cfg.data_stale_threshold_ms + 1 }] }),
    missingField: 'data_age_samples',
  },
  CLOCK_RELIABILITY: {
    failCtx: () => ({
      ...validPreTrade,
      leg_clock_offset: { long: { errorMs: cfg.clock_max_error_ms + 1, calibratedAt: validPreTrade.now }, short: { errorMs: 1, calibratedAt: validPreTrade.now } },
    }),
    missingField: 'leg_clock_offset',
  },
  ENTRY_GATE: {
    failCtx: () => ({ ...validPreTrade, entry_gate_sources: { x: { open: true, reason_code: 'TEST' } } }),
    missingField: 'entry_gate_sources',
  },
};

const ENTRY_SCENARIOS: Record<string, ScenarioEntry> = {
  PRICE_DEVIATION: {
    failCtx: () => ({ ...validEntry, leg_mid_price: { long: 100, short: 100.4 } }),
    missingField: 'leg_mid_price',
  },
  FUNDING_RATE_CHANGE: {
    failCtx: () => ({ ...validEntry, arm_funding_spread: 0.001, current_funding_spread: -0.001 }),
    missingField: 'arm_funding_spread',
  },
  ORDER_TIMEOUT: { failCtx: () => ({ ...validEntry, order_timeout_occurred: true }), missingField: 'order_timeout_occurred' },
  PARTIAL_FILL: {
    failCtx: () => ({ ...validEntry, hedge_state: 'PARTIALLY_HEDGED', partially_hedged_since: 0, now: 10_000 }),
    missingField: 'hedge_state',
  },
  LEG_IMBALANCE: { failCtx: () => ({ ...validEntry, hedge_ratio: 0, both_legs_zero_fill: false }), missingField: 'hedge_ratio' },
  EXCHANGE_CONNECTION: {
    failCtx: () => ({ ...validEntry, leg_connectivity: { long: 'DISCONNECTED', short: 'CONNECTED' } }),
    missingField: 'leg_connectivity',
  },
  MARKET_VOLATILITY: {
    failCtx: () => ({ ...validEntry, leg_recent_mid_prices: { long: [100, 100.1], short: [100, 100.6] } }),
    missingField: 'leg_recent_mid_prices',
  },
};

const POSITION_SCENARIOS: Record<string, ScenarioEntry> = {
  POSITION_IMBALANCE: { failCtx: () => ({ ...validPosition, hedge_ratio: 0.5 }), missingField: 'hedge_ratio' },
  MARK_PRICE_MOVEMENT: {
    failCtx: () => ({ ...validPosition, leg_unrealized_loss_usdt: { long: 0, short: 200 } }),
    missingField: 'leg_unrealized_loss_usdt',
  },
  BASIS_DIVERGENCE: { failCtx: () => ({ ...validPosition, basis_now: 0.1 }), missingField: 'basis_now' },
  FUNDING_CHANGE: {
    failCtx: () => ({ ...validPosition, now: validPosition.hedged_by! - 1000, expected_funding_cashflow_usdt: -10, estimated_exit_cost_usdt: 1 }),
    missingField: 'hedged_by',
  },
  HOLDING_TIME: {
    failCtx: () => ({ ...validPosition, entry_completed_at: 0, now: cfg.max_holding_time_ms + 1 }),
    missingField: 'entry_completed_at',
  },
  EXIT_CONDITION: {
    failCtx: () => ({ ...validPosition, exit_pending_since: 0, now: cfg.emergency_exit_timeout_ms + 1, both_legs_closed: false }),
    missingField: 'both_legs_closed',
  },
};

const PRE_TRADE_CODES = ALL_CHECKS.filter((c) => c.stage === 'PRE_TRADE').map((c) => c.check_code);
const ENTRY_CODES = ALL_CHECKS.filter((c) => c.stage === 'ENTRY').map((c) => c.check_code);
const POSITION_CODES = ALL_CHECKS.filter((c) => c.stage === 'POSITION').map((c) => c.check_code);

describe('every check_code has a FAIL scenario and an INPUT_MISSING scenario', () => {
  it('Pre-Trade: every check_code has a table entry', () => {
    const missing = PRE_TRADE_CODES.filter((code) => !(code in PRE_TRADE_SCENARIOS));
    expect(missing).toEqual([]);
  });
  it('Entry: every check_code has a table entry', () => {
    const missing = ENTRY_CODES.filter((code) => !(code in ENTRY_SCENARIOS));
    expect(missing).toEqual([]);
  });
  it('Position: every check_code has a table entry', () => {
    const missing = POSITION_CODES.filter((code) => !(code in POSITION_SCENARIOS));
    expect(missing).toEqual([]);
  });

  for (const code of PRE_TRADE_CODES) {
    it(`Pre-Trade ${code}: FAIL scenario actually FAILs`, () => {
      const scenario = PRE_TRADE_SCENARIOS[code];
      const ctx = scenario.failCtx() as PreTradeContext;
      const result = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === code)!;
      expect(result.status).toBe('FAIL');
    });
    it(`Pre-Trade ${code}: missing input → FAIL/UNKNOWN/INPUT_MISSING`, () => {
      if (code === 'ENTRY_GATE') {
        // ENTRY_GATE has no "missing" input of its own — an empty/absent
        // `entry_gate_sources` legitimately means "no source has closed the
        // gate" → PASS (spec: "任一來源開啟即 FAIL"). Its FAIL path (an open
        // source) is already covered by the FAIL-scenario test above.
        const ctx: PreTradeContext = { ...validPreTrade, entry_gate_sources: undefined };
        const result = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === code)!;
        expect(result.status).toBe('PASS');
        return;
      }
      const scenario = PRE_TRADE_SCENARIOS[code];
      const ctx: PreTradeContext = { ...validPreTrade, [scenario.missingField]: undefined };
      const result = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === code)!;
      expect(result.status).toBe('FAIL');
      expect(result.value).toBe('UNKNOWN');
      expect(result.reason_code).toBe('INPUT_MISSING');
    });
  }

  for (const code of ENTRY_CODES) {
    it(`Entry ${code}: FAIL scenario actually FAILs`, () => {
      const scenario = ENTRY_SCENARIOS[code];
      const ctx = scenario.failCtx() as EntryContext;
      const result = evaluateEntry(ctx, cfg).items.find((i) => i.check_code === code)!;
      expect(result.status).toBe('FAIL');
    });
    it(`Entry ${code}: missing input → FAIL/UNKNOWN/INPUT_MISSING`, () => {
      const scenario = ENTRY_SCENARIOS[code];
      const ctx: EntryContext = { ...validEntry, [scenario.missingField]: undefined };
      const result = evaluateEntry(ctx, cfg).items.find((i) => i.check_code === code)!;
      expect(result.status).toBe('FAIL');
      expect(result.value).toBe('UNKNOWN');
      expect(result.reason_code).toBe('INPUT_MISSING');
    });
  }

  for (const code of POSITION_CODES) {
    it(`Position ${code}: FAIL scenario actually FAILs`, () => {
      const scenario = POSITION_SCENARIOS[code];
      const ctx = scenario.failCtx() as PositionContext;
      const result = evaluatePosition(ctx, cfg).items.find((i) => i.check_code === code)!;
      expect(result.status).toBe('FAIL');
    });
    it(`Position ${code}: missing input → FAIL/UNKNOWN/INPUT_MISSING`, () => {
      if (code === 'EXIT_CONDITION') {
        // EXIT_CONDITION's only "required" field (both_legs_closed) is only
        // read once exit_pending_since is set — covered by the FAIL scenario
        // above; absence of exit_pending_since itself legitimately PASSes
        // (not in EXIT_PENDING yet), so assert the narrower contract here.
        const ctx: PositionContext = { ...validPosition, exit_pending_since: 0, both_legs_closed: undefined };
        const result = evaluatePosition(ctx, cfg).items.find((i) => i.check_code === code)!;
        expect(result.status).toBe('FAIL');
        expect(result.reason_code).toBe('INPUT_MISSING');
        return;
      }
      const scenario = POSITION_SCENARIOS[code];
      const ctx: PositionContext = { ...validPosition, [scenario.missingField]: undefined };
      const result = evaluatePosition(ctx, cfg).items.find((i) => i.check_code === code)!;
      expect(result.status).toBe('FAIL');
      expect(result.value).toBe('UNKNOWN');
      expect(result.reason_code).toBe('INPUT_MISSING');
    });
  }
});
