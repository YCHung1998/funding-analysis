import { describe, expect, it } from 'vitest';
import { evaluateOpportunityValidity } from './invalidation';
import type { OpportunityEvaluationInput, OpportunityValidationConfig } from './invalidation';

const config: OpportunityValidationConfig = {
  rateChangeTolerance: 0.0002,
  priceChangeTolerancePct: 0.1,
  dataStaleThresholdMs: 5_000,
  opportunityMaxAgeMs: 120_000,
};

function baseInput(overrides: Partial<OpportunityEvaluationInput> = {}): OpportunityEvaluationInput {
  return {
    detectedAt: 0,
    now: 1_000,
    evaluatedPhase: 'SHORTLIST',
    currentPhase: 'SHORTLIST',
    legRateChanges: [0, 0],
    priceDiffChangePct: 0,
    depthCoversQty: true,
    dataAgeMsPerLeg: [100, 100],
    ...overrides,
  };
}

describe('evaluateOpportunityValidity (opportunity-lifecycle spec)', () => {
  it('EXPIREs with PHASE_CHANGED when the session moved past the evaluated phase', () => {
    const result = evaluateOpportunityValidity(
      baseInput({ evaluatedPhase: 'SHORTLIST', currentPhase: 'ARM' }),
      config,
    );
    expect(result).toEqual({ valid: false, status: 'EXPIRED', reason: 'PHASE_CHANGED' });
  });

  it('REJECTs with INPUT_CHANGED when a leg rate moves beyond tolerance', () => {
    const result = evaluateOpportunityValidity(baseInput({ legRateChanges: [0.0003, 0] }), config);
    expect(result).toEqual({ valid: false, status: 'REJECTED', reason: 'INPUT_CHANGED' });
  });

  it('stays valid when the rate change is within tolerance', () => {
    const result = evaluateOpportunityValidity(baseInput({ legRateChanges: [0.0001, 0] }), config);
    expect(result).toEqual({ valid: true });
  });

  it('REJECTs with STALE_MARKET_DATA when any input is older than the threshold', () => {
    const result = evaluateOpportunityValidity(baseInput({ dataAgeMsPerLeg: [100, 5_001] }), config);
    expect(result).toEqual({ valid: false, status: 'REJECTED', reason: 'STALE_MARKET_DATA' });
  });

  it('EXPIREs with MAX_AGE when now - detected_at exceeds the max age', () => {
    const result = evaluateOpportunityValidity(baseInput({ detectedAt: 0, now: 120_001 }), config);
    expect(result).toEqual({ valid: false, status: 'EXPIRED', reason: 'MAX_AGE' });
  });

  it('REJECTs with INPUT_CHANGED when price diff moves beyond tolerance', () => {
    const result = evaluateOpportunityValidity(baseInput({ priceDiffChangePct: 0.2 }), config);
    expect(result).toEqual({ valid: false, status: 'REJECTED', reason: 'INPUT_CHANGED' });
  });

  it('REJECTs with INPUT_CHANGED when available depth no longer covers the target quantity', () => {
    const result = evaluateOpportunityValidity(baseInput({ depthCoversQty: false }), config);
    expect(result).toEqual({ valid: false, status: 'REJECTED', reason: 'INPUT_CHANGED' });
  });
});
