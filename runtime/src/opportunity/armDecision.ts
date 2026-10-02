export interface ArmDecisionInput {
  /** Sign (+1/-1) of the spread as evaluated at SHORTLIST (or whenever the opportunity was qualified). */
  evaluatedSpreadSign: 1 | -1;
  /** Sign of the spread recomputed at arm_at using freshly-read rates. */
  recomputedSpreadSign: 1 | -1;
  /** Net PnL recomputed at arm_at. */
  recomputedNetPnlUsdt: number;
  minimumExpectedNetPnlUsdt: number;
}

export type ArmDecisionReason = 'SPREAD_FLIPPED' | 'BELOW_MIN_NET_PNL';

export type ArmDecisionResult = { selected: true } | { selected: false; reason: ArmDecisionReason };

/**
 * ARM is the final entry decision point (opportunity-lifecycle spec): re-read both legs, recompute
 * net PnL, and only SELECT if the spread direction held and net PnL still clears the minimum.
 */
export function evaluateArmDecision(input: ArmDecisionInput): ArmDecisionResult {
  if (input.recomputedSpreadSign !== input.evaluatedSpreadSign) {
    return { selected: false, reason: 'SPREAD_FLIPPED' };
  }
  if (input.recomputedNetPnlUsdt < input.minimumExpectedNetPnlUsdt) {
    return { selected: false, reason: 'BELOW_MIN_NET_PNL' };
  }
  return { selected: true };
}
