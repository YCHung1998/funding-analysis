import { describe, expect, it } from 'vitest';
import { evaluateArmDecision } from './armDecision';

describe('evaluateArmDecision (opportunity-lifecycle spec "ARM is the final entry decision point")', () => {
  it('rejects with SPREAD_FLIPPED when the recomputed spread sign differs from the evaluated one', () => {
    const result = evaluateArmDecision({
      evaluatedSpreadSign: 1,
      recomputedSpreadSign: -1,
      recomputedNetPnlUsdt: 10,
      minimumExpectedNetPnlUsdt: 1,
    });
    expect(result).toEqual({ selected: false, reason: 'SPREAD_FLIPPED' });
  });

  it('rejects with BELOW_MIN_NET_PNL when recomputed net PnL is below the threshold', () => {
    const result = evaluateArmDecision({
      evaluatedSpreadSign: 1,
      recomputedSpreadSign: 1,
      recomputedNetPnlUsdt: 0.5,
      minimumExpectedNetPnlUsdt: 1,
    });
    expect(result).toEqual({ selected: false, reason: 'BELOW_MIN_NET_PNL' });
  });

  it('selects when spread is unchanged and net PnL meets the threshold', () => {
    const result = evaluateArmDecision({
      evaluatedSpreadSign: 1,
      recomputedSpreadSign: 1,
      recomputedNetPnlUsdt: 5,
      minimumExpectedNetPnlUsdt: 1,
    });
    expect(result).toEqual({ selected: true });
  });
});
