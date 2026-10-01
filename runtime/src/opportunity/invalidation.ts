// TODO(trading-schema-types): 合併後改為 import { SessionPhase } from 'runtime/src/session/settlementSession'
type SessionPhase = 'WATCH' | 'SHORTLIST' | 'ARM' | 'ENTRY' | 'LOCK' | 'CONFIRM' | 'DONE' | 'SKIPPED';

export interface OpportunityEvaluationInput {
  detectedAt: number;
  now: number;
  /** Phase the session was in when this opportunity was last evaluated. */
  evaluatedPhase: SessionPhase;
  /** Phase the session is in now. */
  currentPhase: SessionPhase;
  /** abs(current rate - rate at evaluation) per leg. */
  legRateChanges: number[];
  /** abs(current price diff % - price diff % at evaluation). */
  priceDiffChangePct: number;
  /** Whether current order-book depth still covers the opportunity's target quantity. */
  depthCoversQty: boolean;
  /** data_age_ms for every input, one entry per leg/source. */
  dataAgeMsPerLeg: number[];
}

export interface OpportunityValidationConfig {
  rateChangeTolerance: number;
  priceChangeTolerancePct: number;
  dataStaleThresholdMs: number;
  opportunityMaxAgeMs: number;
}

export type InvalidationReason = 'PHASE_CHANGED' | 'INPUT_CHANGED' | 'STALE_MARKET_DATA' | 'MAX_AGE';

export type OpportunityValidationResult =
  | { valid: true }
  | { valid: false; status: 'EXPIRED' | 'REJECTED'; reason: InvalidationReason };

/**
 * Opportunity invalidation rules replacing the fixed 2s TTL (opportunity-lifecycle spec
 * "Opportunity invalidation replaces fixed TTL"). Conditions 1/4 -> EXPIRED, 2/3 -> REJECTED.
 * Condition 5 (contract eligibility) is evaluated separately via
 * `session/eligibility.ts#evaluateContractEligibility` with freshly-read leg data and combined
 * by the caller — it needs instrument-registry data this module does not own.
 */
export function evaluateOpportunityValidity(
  input: OpportunityEvaluationInput,
  config: OpportunityValidationConfig,
): OpportunityValidationResult {
  if (input.currentPhase !== input.evaluatedPhase) {
    return { valid: false, status: 'EXPIRED', reason: 'PHASE_CHANGED' };
  }

  const rateChanged = input.legRateChanges.some((delta) => delta > config.rateChangeTolerance);
  const priceChanged = input.priceDiffChangePct > config.priceChangeTolerancePct;
  if (rateChanged || priceChanged || !input.depthCoversQty) {
    return { valid: false, status: 'REJECTED', reason: 'INPUT_CHANGED' };
  }

  if (input.dataAgeMsPerLeg.some((age) => age > config.dataStaleThresholdMs)) {
    return { valid: false, status: 'REJECTED', reason: 'STALE_MARKET_DATA' };
  }

  if (input.now - input.detectedAt > config.opportunityMaxAgeMs) {
    return { valid: false, status: 'EXPIRED', reason: 'MAX_AGE' };
  }

  return { valid: true };
}
