/**
 * runtime/src/risk/positionRisk.ts
 *
 * `evaluatePosition` — the 6-item Position Risk evaluator for `HEDGED` /
 * `EXIT_PENDING` (design.md Decision 1/3, spec.md Position requirements).
 * FAIL always requests `EMERGENCY_EXIT`; WARN never triggers an action
 * (spec "FAIL 項目的動作為 EMERGENCY_EXIT（WARN 不動作）").
 */
import { LEGS } from './types';
import type { Leg, PositionContext, RiskCheckResult, RiskConfig, RiskEvaluation } from './types';
import { failResult, inputMissing, passResult, warnResult } from './types';
import { POSITION_CHECKS, findCheck } from './checks/registry';

function legLabel(leg: Leg): string {
  return leg;
}

function positionImbalance(ctx: PositionContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('POSITION_IMBALANCE');
  if (ctx.hedge_ratio === undefined) return inputMissing(def);
  if (ctx.hedge_ratio < cfg.hedge_ratio_imbalance_below) {
    return failResult(def, String(ctx.hedge_ratio), `>= ${cfg.hedge_ratio_imbalance_below}`, 'POSITION_IMBALANCE');
  }
  if (ctx.hedge_ratio < cfg.hedge_ratio_hedged_min) {
    return warnResult(def, String(ctx.hedge_ratio), `>= ${cfg.hedge_ratio_hedged_min}`, 'POSITION_IMBALANCE_WARN');
  }
  return passResult(def, String(ctx.hedge_ratio), `>= ${cfg.hedge_ratio_hedged_min}`);
}

function markPriceMovement(ctx: PositionContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('MARK_PRICE_MOVEMENT');
  for (const leg of LEGS) {
    const loss = ctx.leg_unrealized_loss_usdt?.[leg];
    const margin = ctx.leg_margin_allocated_usdt?.[leg];
    if (loss === undefined || margin === undefined) return inputMissing(def);
  }
  for (const leg of LEGS) {
    const loss = ctx.leg_unrealized_loss_usdt![leg]!;
    const margin = ctx.leg_margin_allocated_usdt![leg]!;
    const ratio = margin === 0 ? Infinity : loss / margin;
    if (ratio >= cfg.max_leg_margin_loss_ratio) {
      return failResult(def, `${legLabel(leg)}: ${ratio}`, `< ${cfg.max_leg_margin_loss_ratio}`, 'MARK_PRICE_ADVERSE');
    }
  }
  return passResult(def, 'within margin', `< ${cfg.max_leg_margin_loss_ratio}`);
}

function basisDivergence(ctx: PositionContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('BASIS_DIVERGENCE');
  if (ctx.basis_now === undefined || ctx.basis_at_entry === undefined) return inputMissing(def);
  const divergence = Math.abs(ctx.basis_now - ctx.basis_at_entry);
  if (divergence > cfg.max_basis_divergence_pct) {
    return failResult(def, String(divergence), `<= ${cfg.max_basis_divergence_pct}`, 'BASIS_DIVERGENCE');
  }
  if (divergence > cfg.max_basis_divergence_pct / 2) {
    return warnResult(def, String(divergence), `<= ${cfg.max_basis_divergence_pct / 2}`, 'BASIS_DIVERGENCE_WARN');
  }
  return passResult(def, String(divergence), `<= ${cfg.max_basis_divergence_pct}`);
}

function fundingChange(ctx: PositionContext): RiskCheckResult {
  const def = findCheck('FUNDING_CHANGE');
  const { hedged_by, expected_funding_cashflow_usdt, estimated_exit_cost_usdt, now } = ctx;
  if (hedged_by === undefined || expected_funding_cashflow_usdt === undefined || estimated_exit_cost_usdt === undefined) {
    return inputMissing(def);
  }
  const flipped = expected_funding_cashflow_usdt < -estimated_exit_cost_usdt;
  if (!flipped) {
    return passResult(def, String(expected_funding_cashflow_usdt), `>= ${-estimated_exit_cost_usdt}`);
  }
  if (now < hedged_by) {
    return failResult(
      def,
      String(expected_funding_cashflow_usdt),
      `>= ${-estimated_exit_cost_usdt}`,
      'FUNDING_FLIPPED',
    );
  }
  return warnResult(
    def,
    String(expected_funding_cashflow_usdt),
    `>= ${-estimated_exit_cost_usdt}`,
    'FUNDING_FLIPPED_LOCKED',
  );
}

function holdingTime(ctx: PositionContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('HOLDING_TIME');
  if (ctx.entry_completed_at === undefined) return inputMissing(def);
  const held = ctx.now - ctx.entry_completed_at;
  if (held > cfg.max_holding_time_ms) {
    return failResult(def, `${held}ms`, `<= ${cfg.max_holding_time_ms}ms`, 'HOLDING_TIME_EXCEEDED');
  }
  return passResult(def, `${held}ms`, `<= ${cfg.max_holding_time_ms}ms`);
}

function exitCondition(ctx: PositionContext, cfg: RiskConfig): RiskCheckResult {
  const def = findCheck('EXIT_CONDITION');
  if (ctx.exit_pending_since === undefined) {
    return passResult(def, 'not EXIT_PENDING', 'n/a');
  }
  if (ctx.both_legs_closed === undefined) return inputMissing(def);
  if (ctx.both_legs_closed) {
    return passResult(def, 'closed', 'closed');
  }
  const elapsed = ctx.now - ctx.exit_pending_since;
  if (elapsed > cfg.emergency_exit_timeout_ms) {
    return failResult(def, `${elapsed}ms`, `<= ${cfg.emergency_exit_timeout_ms}ms`, 'EXIT_STALLED');
  }
  return passResult(def, `${elapsed}ms`, `<= ${cfg.emergency_exit_timeout_ms}ms`);
}

const CHECK_FNS: Record<string, (ctx: PositionContext, cfg: RiskConfig) => RiskCheckResult> = {
  POSITION_IMBALANCE: positionImbalance,
  MARK_PRICE_MOVEMENT: markPriceMovement,
  BASIS_DIVERGENCE: basisDivergence,
  FUNDING_CHANGE: (ctx) => fundingChange(ctx),
  HOLDING_TIME: holdingTime,
  EXIT_CONDITION: exitCondition,
};

/** Runs all 6 Position checks, in registry order. Any FAIL requests EMERGENCY_EXIT. */
export function evaluatePosition(ctx: PositionContext, cfg: RiskConfig): RiskEvaluation {
  const items = POSITION_CHECKS.map((def) => CHECK_FNS[def.check_code](ctx, cfg));
  const failed = items.filter((i) => i.status === 'FAIL');
  const action = failed.length > 0 ? 'EMERGENCY_EXIT' : 'CONTINUE';
  const legImbalanceFailed = items.some((i) => i.check_code === 'POSITION_IMBALANCE' && i.status === 'FAIL');
  return {
    stage: 'POSITION',
    evaluated_at: ctx.now,
    config_version: cfg.config_version,
    items,
    action,
    failed_reasons: failed.map((i) => i.reason_code!).filter((r): r is string => r !== undefined),
    leg_imbalance_detected: legImbalanceFailed,
  };
}
