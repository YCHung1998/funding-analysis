// TODO(trading-schema-types): 合併後改為 import { TradingEvent } from 'runtime/src/types'

export type OpportunityEventType =
  | 'OPPORTUNITY_DETECTED'
  | 'OPPORTUNITY_QUALIFIED'
  | 'OPPORTUNITY_SELECTED'
  | 'OPPORTUNITY_REJECTED'
  | 'OPPORTUNITY_EXPIRED';

export interface OpportunityEvent {
  type: OpportunityEventType;
  opportunityId: string;
  at: number;
  detectedAt: number;
  reason?: string;
}

/**
 * Builds one opportunity trading event (opportunity-lifecycle spec "Every opportunity state
 * change is recorded"). Opportunities that are never traded still get recorded — callers emit
 * this for every status transition, including rejections.
 */
export function createOpportunityEvent(input: {
  type: OpportunityEventType;
  opportunityId: string;
  at: number;
  detectedAt: number;
  reason?: string;
}): OpportunityEvent {
  return { ...input };
}
