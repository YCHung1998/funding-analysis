/**
 * runtime/src/types/risk.ts
 *
 * `RiskStatusReport` / `RiskCheckItem` moved verbatim from
 * `src/types/systemSpec.ts` (spec §6 "沿用"; design.md Decision 3) — the
 * research side now re-exports these from here instead of defining them,
 * so the shape has a single source while C-11 rule 3 (`runtime/src/` must
 * not import `src/`) stays satisfied.
 *
 * `RiskCheck` is the new, separate v0.2 persisted entity (spec.md
 * "Supporting entity shapes" requirement) — NOT the same as `RiskCheckItem`
 * above, which is the UI-facing pre-flight checklist item shape.
 */

/** Moved verbatim from `src/types/systemSpec.ts` (shape unchanged). */
export interface RiskCheckItem {
  id: string;
  name: string;
  category: 'Connection' | 'Execution' | 'Market' | 'Capital';
  status: 'PASS' | 'WARN' | 'FAIL';
  value: string;
  threshold: string;
  details: string;
}

/** Moved verbatim from `src/types/systemSpec.ts` (shape unchanged). */
export interface RiskStatusReport {
  overall_status: 'PASS' | 'ABORT' | 'EMERGENCY_EXIT';
  checks: RiskCheckItem[];
  failed_reasons: string[];
  leg_imbalance_detected: boolean;
  action_recommendation: 'PROCEED_TRADE' | 'ABORT_PRE_FLIGHT' | 'EMERGENCY_CLOSE_FILLED_LEG';
}

/** v0.2 persisted risk-check record (spec.md "Supporting entity shapes"). */
export interface RiskCheck {
  risk_check_id: string;
  opportunity_id: string;
  trade_id?: string;
  stage: 'OPPORTUNITY' | 'TRADE_CREATION' | 'ORDER_SUBMISSION' | 'ENTRY' | 'POSITION';
  check_id: string;
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  critical: boolean;
  value: string;
  threshold: string;
  reason?: string;
  config_version: string;
  created_at: number;
  updated_at: number;
}
