import { describe, expect, it } from 'vitest';
import { createOpportunityEvent } from './events';

describe('createOpportunityEvent (opportunity-lifecycle spec "Every opportunity state change is recorded")', () => {
  it('records a rejected opportunity with its reason and detected_at, queryable after the fact', () => {
    const event = createOpportunityEvent({
      type: 'OPPORTUNITY_REJECTED',
      opportunityId: 'opp-1',
      at: 5_000,
      detectedAt: 1_000,
      reason: 'EXCHANGE_NOT_TRADABLE',
    });

    expect(event).toEqual({
      type: 'OPPORTUNITY_REJECTED',
      opportunityId: 'opp-1',
      at: 5_000,
      detectedAt: 1_000,
      reason: 'EXCHANGE_NOT_TRADABLE',
    });
  });

  it('allows OPPORTUNITY_DETECTED with no reason', () => {
    const event = createOpportunityEvent({
      type: 'OPPORTUNITY_DETECTED',
      opportunityId: 'opp-2',
      at: 100,
      detectedAt: 100,
    });
    expect(event.reason).toBeUndefined();
  });
});
