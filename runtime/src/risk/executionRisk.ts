/**
 * runtime/src/risk/executionRisk.ts
 *
 * `evaluateEntry` — the 7-item Entry Risk evaluator for `ENTRY_PENDING` /
 * `PARTIALLY_HEDGED` (design.md Decision 1/3, spec.md Entry requirements).
 * Pure function; the Trade/Order state transition semantics stay in
 * `paper-execution` — this module only judges and recommends an action
 * (spec "Risk Engine MUST NOT 自行改變 Trade / Order 狀態").
 *
 * Every numeric input goes through `isFiniteNumber` (not a raw
 * `=== undefined` check) so `undefined`/`NaN`/`±Infinity` are all
 * INPUT_MISSING, never silently compared (integrator review fail-open bug
 * — see `preTradeRisk.ts`'s header for the full rationale). If `ctx.now` is
 * invalid, every item is INPUT_MISSING.
 */
import { LEGS } from './types';
import type { EntryContext, Leg, RiskCheckResult, RiskConfig, RiskEvaluation } from './types';
import { failResult, inputMissing, passResult, warnResult } from './types';
import { isFiniteNumber, isPresent } from './validation';
import { ENTRY_CHECKS, findCheck } from './checks/registry';

function legLabel(leg: Leg): string {
  return leg;
}

function priceDeviation(ctx: EntryContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('PRICE_DEVIATION');
  const { leg_mid_price, leg_target_entry_price } = ctx;
  for (const leg of LEGS) {
    if (!isFiniteNumber(leg_mid_price?.[leg]) || !isFiniteNumber(leg_target_entry_price?.[leg])) {
      return inputMissing(def);
    }
  }
  for (const leg of LEGS) {
    const mid = leg_mid_price![leg]!;
    const target = leg_target_entry_price![leg]!;
    const deviation = Math.abs(mid - target) / target;
    if (deviation > cfg.max_entry_price_deviation_pct) {
      return failResult(
        def,
        `${legLabel(leg)}: ${deviation}`,
        `<= ${cfg.max_entry_price_deviation_pct}`,
        'PRICE_DEVIATION',
      );
    }
  }
  return passResult(def, 'within tolerance', `<= ${cfg.max_entry_price_deviation_pct}`);
}

function fundingRateChange(ctx: EntryContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('FUNDING_RATE_CHANGE');
  const { arm_funding_spread, current_funding_spread } = ctx;
  if (!isFiniteNumber(arm_funding_spread) || !isFiniteNumber(current_funding_spread)) return inputMissing(def);
  const signFlipped = Math.sign(arm_funding_spread) !== Math.sign(current_funding_spread) && arm_funding_spread !== 0;
  const shrunkTooMuch = arm_funding_spread - current_funding_spread > cfg.rate_change_tolerance;
  if (signFlipped || shrunkTooMuch) {
    return failResult(
      def,
      `arm=${arm_funding_spread}, now=${current_funding_spread}`,
      `shrink <= ${cfg.rate_change_tolerance}`,
      'FUNDING_RATE_CHANGED',
    );
  }
  return passResult(def, `arm=${arm_funding_spread}, now=${current_funding_spread}`, `shrink <= ${cfg.rate_change_tolerance}`);
}

function orderTimeout(ctx: EntryContext): RiskCheckResult {
  const def = findCheck('ORDER_TIMEOUT');
  if (!isPresent(ctx.order_timeout_occurred)) return inputMissing(def);
  if (ctx.order_timeout_occurred) {
    return failResult(def, 'true', 'false', 'ORDER_TIMEOUT');
  }
  return passResult(def, 'false', 'false');
}

function partialFill(ctx: EntryContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('PARTIAL_FILL');
  if (!isPresent(ctx.hedge_state)) return inputMissing(def);
  if (ctx.hedge_state !== 'PARTIALLY_HEDGED') {
    return passResult(def, ctx.hedge_state, 'not PARTIALLY_HEDGED');
  }
  if (!isFiniteNumber(ctx.partially_hedged_since)) return inputMissing(def);
  const duration = ctx.now - ctx.partially_hedged_since;
  if (duration >= cfg.partial_hedge_max_duration_ms) {
    return failResult(def, `${duration}ms`, `< ${cfg.partial_hedge_max_duration_ms}ms`, 'PARTIAL_HEDGE_TIMEOUT');
  }
  return warnResult(def, `${duration}ms`, `< ${cfg.partial_hedge_max_duration_ms}ms`, 'PARTIAL_HEDGE_PENDING');
}

function legImbalance(ctx: EntryContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('LEG_IMBALANCE');
  if (!isFiniteNumber(ctx.hedge_ratio)) return inputMissing(def);
  if (ctx.both_legs_zero_fill) {
    return passResult(def, '0/0', 'n/a — both legs zero fill');
  }
  if (ctx.hedge_ratio < cfg.hedge_ratio_imbalance_below) {
    return failResult(def, String(ctx.hedge_ratio), `>= ${cfg.hedge_ratio_imbalance_below}`, 'LEG_IMBALANCE');
  }
  return passResult(def, String(ctx.hedge_ratio), `>= ${cfg.hedge_ratio_imbalance_below}`);
}

function exchangeConnection(ctx: EntryContext): RiskCheckResult {
  const def = findCheck('EXCHANGE_CONNECTION');
  for (const leg of LEGS) {
    const conn = ctx.leg_connectivity?.[leg];
    if (!isPresent(conn)) return inputMissing(def);
    if (conn !== 'CONNECTED') {
      return failResult(def, `${legLabel(leg)}: ${conn}`, 'CONNECTED', 'EXCHANGE_DISCONNECTED');
    }
  }
  return passResult(def, 'CONNECTED', 'CONNECTED');
}

function marketVolatility(ctx: EntryContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('MARKET_VOLATILITY');
  for (const leg of LEGS) {
    const samples = ctx.leg_recent_mid_prices?.[leg];
    if (!Array.isArray(samples) || samples.length < 2 || !samples.every((v) => isFiniteNumber(v))) {
      return inputMissing(def);
    }
  }
  for (const leg of LEGS) {
    const samples = ctx.leg_recent_mid_prices![leg]!;
    const max = Math.max(...samples);
    const min = Math.min(...samples);
    const range = (max - min) / min;
    if (range > cfg.max_entry_volatility_pct) {
      return failResult(def, `${legLabel(leg)}: ${range}`, `<= ${cfg.max_entry_volatility_pct}`, 'MARKET_VOLATILITY');
    }
  }
  return passResult(def, 'stable', `<= ${cfg.max_entry_volatility_pct}`);
}

const CHECK_FNS: Record<string, (ctx: EntryContext, cfg: RiskConfig) => RiskCheckResult> = {
  PRICE_DEVIATION: priceDeviation,
  FUNDING_RATE_CHANGE: fundingRateChange,
  ORDER_TIMEOUT: (ctx) => orderTimeout(ctx),
  PARTIAL_FILL: partialFill,
  LEG_IMBALANCE: legImbalance,
  EXCHANGE_CONNECTION: (ctx) => exchangeConnection(ctx),
  MARKET_VOLATILITY: marketVolatility,
};

const SEVERITY: Record<string, number> = { CONTINUE: 0, HALT_ENTRY: 1, EMERGENCY_EXIT: 2 };

function worstAction(items: RiskCheckResult[]): 'CONTINUE' | 'HALT_ENTRY' | 'EMERGENCY_EXIT' {
  let worst: 'CONTINUE' | 'HALT_ENTRY' | 'EMERGENCY_EXIT' = 'CONTINUE';
  for (const item of items) {
    if (item.status !== 'FAIL' || !item.action) continue;
    if (SEVERITY[item.action] > SEVERITY[worst]) worst = item.action;
  }
  return worst;
}

/** Runs all 7 Entry checks, in registry order. If `ctx.now` is invalid, every item is INPUT_MISSING. */
export function evaluateEntry(ctx: EntryContext, cfg: RiskConfig): RiskEvaluation {
  const items = isFiniteNumber(ctx.now)
    ? ENTRY_CHECKS.map((def) => CHECK_FNS[def.check_code](ctx, cfg))
    : ENTRY_CHECKS.map((def) => inputMissing(def));
  const action = worstAction(items);
  const failed = items.filter((i) => i.status === 'FAIL');
  const legImbalanceFailed = items.some(
    (i) => i.check_code === 'LEG_IMBALANCE' && i.status === 'FAIL',
  );
  return {
    stage: 'ENTRY',
    evaluated_at: ctx.now,
    config_version: cfg.config_version,
    items,
    action,
    failed_reasons: failed.map((i) => i.reason_code!).filter((r): r is string => r !== undefined),
    leg_imbalance_detected: legImbalanceFailed,
  };
}
