/**
 * runtime/src/risk/types.ts
 *
 * Shared evaluation-result shapes, the check registry entry shape, the
 * per-stage context shapes, and the injected port interfaces the Risk
 * Engine depends on (design.md Decision 8: several providers — `cost-model`,
 * `position-accounting`, `runtime-health`, `instrument-registry`,
 * `market-data-stream` — don't exist yet as separate changes; per the task
 * brief, minimal port interfaces are defined here instead, with names that
 * do not collide with `runtime/src/types/` reserved trading-schema names —
 * see `runtime/test/typeOwnership.test.ts`).
 *
 * All money/rate/ratio values are decimals (Invariant #5): a "pct" field
 * name (kept for parity with design.md's table) is still compared as a
 * decimal, e.g. 0.001 = 0.1% — see design.md Open Question 6.
 */

import type { ExchangeId } from '../types/ids';

// ---------------------------------------------------------------------------
// Leg identity — two legs only ("long" / "short"); which real exchange each
// one is on is carried as data (`ExchangeId`), never branched on by name
// (HANDOFF §3 Invariant #3).
// ---------------------------------------------------------------------------
export type Leg = 'long' | 'short';
export const LEGS: readonly Leg[] = ['long', 'short'];
export type LegMap<T> = Record<Leg, T>;
export type PartialLegMap<T> = Partial<LegMap<T>>;

// ---------------------------------------------------------------------------
// Check result / evaluation model (design.md Decision 1 `RiskEvaluation`)
// ---------------------------------------------------------------------------

export type CheckStage = 'PRE_TRADE' | 'ENTRY' | 'POSITION';
export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';
export type RiskCategory = 'Connection' | 'Execution' | 'Market' | 'Capital';

/** Stage-level action recommendation (design.md Decision 1/2). */
export type StageAction = 'ALLOW' | 'BLOCK' | 'CONTINUE' | 'HALT_ENTRY' | 'EMERGENCY_EXIT';

/** Per-item action a FAILed ENTRY/POSITION check requests (design.md §22 table). */
export type ItemAction = 'HALT_ENTRY' | 'EMERGENCY_EXIT';

export interface RiskCheckResult {
  check_id: string;
  check_code: string;
  name: string;
  stage: CheckStage;
  critical: boolean;
  category: RiskCategory;
  status: CheckStatus;
  value: string;
  threshold: string;
  reason_code?: string;
  /** Only meaningful for ENTRY/POSITION FAIL items — the action that FAIL requests. */
  action?: ItemAction;
  /** Raw inputs used for this evaluation (for the `RISK_CHECK_FAILED` event payload). */
  inputs?: Record<string, unknown>;
}

export interface CheckDefinition {
  check_code: string;
  name: string;
  stage: CheckStage;
  critical: boolean;
  category: RiskCategory;
  /** Entry/Position stage default action a FAIL of this check requests. */
  failAction?: ItemAction;
}

export const INPUT_MISSING_REASON = 'INPUT_MISSING';

/** Builds the canonical FAIL-on-missing-input result (spec "輸入缺失不得 PASS"). */
export function inputMissing(def: CheckDefinition): RiskCheckResult {
  return {
    check_id: def.check_code,
    check_code: def.check_code,
    name: def.name,
    stage: def.stage,
    critical: def.critical,
    category: def.category,
    status: 'FAIL',
    value: 'UNKNOWN',
    threshold: '',
    reason_code: INPUT_MISSING_REASON,
    action: def.failAction,
  };
}

export function passResult(def: CheckDefinition, value: string, threshold: string): RiskCheckResult {
  return {
    check_id: def.check_code,
    check_code: def.check_code,
    name: def.name,
    stage: def.stage,
    critical: def.critical,
    category: def.category,
    status: 'PASS',
    value,
    threshold,
  };
}

export function warnResult(def: CheckDefinition, value: string, threshold: string, reason_code: string): RiskCheckResult {
  return {
    check_id: def.check_code,
    check_code: def.check_code,
    name: def.name,
    stage: def.stage,
    critical: def.critical,
    category: def.category,
    status: 'WARN',
    value,
    threshold,
    reason_code,
  };
}

export function failResult(
  def: CheckDefinition,
  value: string,
  threshold: string,
  reason_code: string,
  inputs?: Record<string, unknown>,
): RiskCheckResult {
  return {
    check_id: def.check_code,
    check_code: def.check_code,
    name: def.name,
    stage: def.stage,
    critical: def.critical,
    category: def.category,
    status: 'FAIL',
    value,
    threshold,
    reason_code,
    action: def.failAction,
    inputs,
  };
}

export interface RiskEvaluation {
  stage: CheckStage;
  evaluated_at: number;
  config_version: string;
  items: RiskCheckResult[];
  action: StageAction;
  failed_reasons: string[];
  leg_imbalance_detected: boolean;
}

// ---------------------------------------------------------------------------
// RiskConfig — new `PaperTradingConfig` fields (design.md Decision 3 / §38).
// All thresholds are decimals where applicable (Invariant #5). Every value
// here has a placeholder default (design.md Open Question 8: "請使用者確認
// 起始值") — defaults are NOT a user decision, they are starting points to
// be calibrated from Paper data per spec §14.3.
// ---------------------------------------------------------------------------
export interface RiskConfig {
  config_version: string;

  max_positions: number;
  max_positions_per_session?: number;
  max_notional_per_leg_usdt: number;
  max_leverage: number;

  minimum_funding_spread_pct: number;
  minimum_expected_net_pnl_usdt: number;
  max_slippage_pct: number;
  depth_coverage_ratio: number;

  max_api_latency_ms: number;
  warn_api_latency_ms: number;
  funding_alignment_tolerance_ms: number;
  max_exchange_notional_usdt: number;
  data_stale_threshold_ms: number;
  clock_max_error_ms: number;
  clock_calibration_max_age_ms: number;

  max_entry_price_deviation_pct: number;
  rate_change_tolerance: number;
  max_order_lifetime_ms: number;
  ack_timeout_ms: number;
  partial_hedge_max_duration_ms: number;
  hedge_ratio_imbalance_below: number;
  hedge_ratio_hedged_min: number;
  volatility_window_ms: number;
  max_entry_volatility_pct: number;

  max_leg_margin_loss_ratio: number;
  max_basis_divergence_pct: number;
  max_holding_time_ms: number;
  emergency_exit_timeout_ms: number;

  entry_risk_interval_ms: number;
  position_risk_interval_ms: number;

  // Kill Switch (design.md §7, C-16 decided 2026-10-02).
  auto_kill_stale_duration_ms: number;
  kill_switch_flatten_confirm_ttl_ms: number;
  kill_switch_cancel_retry_max: number;
  kill_switch_cancel_retry_interval_ms: number;
}

/**
 * Placeholder starting values — NOT a resolved decision (design.md Open
 * Question 8). Callers SHOULD override via `{ ...DEFAULT_RISK_CONFIG, ... }`.
 */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  config_version: 'risk-config-v0',

  max_positions: 5,
  max_notional_per_leg_usdt: 1000,
  max_leverage: 5,

  minimum_funding_spread_pct: 0.0005,
  minimum_expected_net_pnl_usdt: 1,
  max_slippage_pct: 0.001,
  depth_coverage_ratio: 3,

  max_api_latency_ms: 500,
  warn_api_latency_ms: 200,
  funding_alignment_tolerance_ms: 60_000,
  max_exchange_notional_usdt: 3000,
  data_stale_threshold_ms: 2000,
  clock_max_error_ms: 500,
  clock_calibration_max_age_ms: 180_000,

  max_entry_price_deviation_pct: 0.003,
  rate_change_tolerance: 0.0002,
  max_order_lifetime_ms: 500,
  ack_timeout_ms: 2000,
  partial_hedge_max_duration_ms: 5000,
  hedge_ratio_imbalance_below: 0.9,
  hedge_ratio_hedged_min: 0.99,
  volatility_window_ms: 5000,
  max_entry_volatility_pct: 0.005,

  max_leg_margin_loss_ratio: 0.5,
  max_basis_divergence_pct: 0.005,
  max_holding_time_ms: 600_000,
  emergency_exit_timeout_ms: 5000,

  entry_risk_interval_ms: 250,
  position_risk_interval_ms: 1000,

  auto_kill_stale_duration_ms: 10_000,
  kill_switch_flatten_confirm_ttl_ms: 10_000,
  kill_switch_cancel_retry_max: 3,
  kill_switch_cancel_retry_interval_ms: 500,
};

// ---------------------------------------------------------------------------
// Pre-Trade context
// ---------------------------------------------------------------------------

export type ConnectivityStatus = 'CONNECTED' | 'DISCONNECTED' | string;
export type InstrumentTradingStatus = 'TRADING' | string;

export interface ClockOffsetSample {
  errorMs: number;
  calibratedAt: number;
}

export interface DataAgeSample {
  name: string;
  ageMs: number;
}

export interface EntryGateSource {
  open: boolean;
  reason_code: string;
}

export interface PreTradeContext {
  now: number;
  legExchange?: PartialLegMap<ExchangeId>;

  required_capital_usdt?: number;
  available_capital_usdt?: number;

  non_terminal_trade_count?: number;
  non_terminal_trade_count_in_session?: number;
  session_id?: string;

  target_notional_per_leg_usdt?: number;

  leverage?: number;
  leg_max_leverage?: PartialLegMap<number>;

  long_funding_rate?: number;
  short_funding_rate?: number;

  estimated_net_pnl_usdt?: number;

  leg_estimated_slippage_pct?: PartialLegMap<number>;
  leg_depth_usdt?: PartialLegMap<number>;

  leg_connectivity?: PartialLegMap<ConnectivityStatus>;
  leg_instrument_status?: PartialLegMap<InstrumentTradingStatus>;

  leg_api_latency_samples_ms?: PartialLegMap<number[]>;

  funding_time_eligible?: boolean;
  funding_time_fail_reason?: 'FUNDING_NOT_ALIGNED' | 'FUNDING_INTERVAL_TOO_SHORT' | 'EXCHANGE_NOT_TRADABLE';
  entry_deadline?: number;

  same_symbol_existing_exposure?: boolean;
  /** existing non-terminal notional already allocated on that leg's exchange, excluding this trade. */
  leg_exchange_existing_notional_usdt?: PartialLegMap<number>;

  data_age_samples?: DataAgeSample[];

  leg_clock_offset?: PartialLegMap<ClockOffsetSample>;

  /** Each source independently opens/closes the gate; any open source → FAIL. */
  entry_gate_sources?: Record<string, EntryGateSource>;
}

/** The 6 Pre-Trade checks PRE_FLIGHT reruns (design.md §14 table, ★ marked). */
export const PRE_FLIGHT_RERUN_CODES = [
  'EXCHANGE_CONNECTIVITY',
  'API_LATENCY',
  'FUNDING_TIME_ALIGNMENT',
  'DATA_FRESHNESS',
  'CLOCK_RELIABILITY',
  'ENTRY_GATE',
] as const;

// ---------------------------------------------------------------------------
// Entry context
// ---------------------------------------------------------------------------

export interface EntryContext {
  now: number;

  leg_mid_price?: PartialLegMap<number>;
  leg_target_entry_price?: PartialLegMap<number>;

  arm_funding_spread?: number;
  current_funding_spread?: number;

  order_timeout_occurred?: boolean;

  hedge_state?: 'PENDING' | 'PARTIALLY_HEDGED' | 'HEDGED' | 'LEG_IMBALANCE';
  partially_hedged_since?: number;

  /** Set once any entry order reaches a terminal state and hedge_ratio is known (C-19 basis injected). */
  hedge_ratio?: number;
  both_legs_zero_fill?: boolean;

  leg_connectivity?: PartialLegMap<ConnectivityStatus>;

  /** Mid-price samples within `volatility_window_ms`, oldest first. */
  leg_recent_mid_prices?: PartialLegMap<number[]>;
}

// ---------------------------------------------------------------------------
// Position context
// ---------------------------------------------------------------------------

export interface PositionContext {
  now: number;

  hedge_ratio?: number;

  leg_unrealized_loss_usdt?: PartialLegMap<number>;
  leg_margin_allocated_usdt?: PartialLegMap<number>;

  basis_now?: number;
  basis_at_entry?: number;

  hedged_by?: number;
  expected_funding_cashflow_usdt?: number;
  estimated_exit_cost_usdt?: number;

  entry_completed_at?: number;

  exit_pending_since?: number;
  both_legs_closed?: boolean;
}

// ---------------------------------------------------------------------------
// Injected ports (design.md Decision 8 — minimal interfaces for not-yet-
// existing capabilities; names chosen to avoid any collision with
// `runtime/src/types/` reserved trading-schema names).
// ---------------------------------------------------------------------------

/** Port for `event-store` (not yet implemented as its own change). */
export interface RiskEventSink {
  emit(event: import('../types/event').TradingEvent): void;
}

/** Port for the `risk_checks` table (owned by `trading-event-store`, not yet implemented). */
export interface RiskCheckSink {
  record(rows: import('../types/risk').RiskCheck[]): void;
}

/** Port for `position-accounting` capital reservation (§7/§12), not yet implemented. */
export interface CapitalLedgerPort {
  reserve(tradeId: string, amountUsdt: number): void;
  release(tradeId: string, reason: string): void;
}
