import type { ExchangeId } from './types';

/** Minimal per-leg info needed for contract eligibility (instrument-registry will provide this upstream). */
export interface CandidateLegInfo {
  exchange: ExchangeId;
  /** This leg's next funding time, epoch ms (freshly read at each re-evaluation). */
  nextFundingTime: number;
  /** This leg's current funding interval, in hours (freshly read at each re-evaluation). */
  fundingIntervalHours: number;
}

export interface EligibilityConfig {
  tradingExchanges: ExchangeId[];
  fundingAlignmentToleranceMs: number;
}

export const MIN_FUNDING_INTERVAL_HOURS = 2;

export type EligibilityReason = 'EXCHANGE_NOT_TRADABLE' | 'FUNDING_INTERVAL_TOO_SHORT' | 'FUNDING_NOT_ALIGNED';

export type EligibilityResult = { eligible: true } | { eligible: false; reason: EligibilityReason };

/**
 * Contract eligibility for a session (settlement-session spec "Contract eligibility for a
 * session"). MUST be called again at SHORTLIST and ARM with freshly-read leg info — this
 * function itself is stateless/pure, so callers control when it gets a fresh reading.
 */
export function evaluateContractEligibility(
  legA: CandidateLegInfo,
  legB: CandidateLegInfo,
  config: EligibilityConfig,
): EligibilityResult {
  if (!config.tradingExchanges.includes(legA.exchange) || !config.tradingExchanges.includes(legB.exchange)) {
    return { eligible: false, reason: 'EXCHANGE_NOT_TRADABLE' };
  }

  if (legA.fundingIntervalHours < MIN_FUNDING_INTERVAL_HOURS || legB.fundingIntervalHours < MIN_FUNDING_INTERVAL_HOURS) {
    return { eligible: false, reason: 'FUNDING_INTERVAL_TOO_SHORT' };
  }

  if (Math.abs(legA.nextFundingTime - legB.nextFundingTime) > config.fundingAlignmentToleranceMs) {
    return { eligible: false, reason: 'FUNDING_NOT_ALIGNED' };
  }

  return { eligible: true };
}
