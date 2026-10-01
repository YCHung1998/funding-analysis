/**
 * runtime/src/types/status.ts
 *
 * Status enums (as `as const` arrays, spec §9/§18/§26) and their transition
 * tables, plus `isAllowedTransition` / `transitionEventType` (design.md
 * Decision 4). Arrays are used instead of TypeScript `enum` so the same
 * value is both a type and iterable runtime data (needed by the glossary
 * completeness test and the exhaustive-transition tests).
 */
import type { TradingEventType } from './event';

// ---------------------------------------------------------------------------
// Order (spec §9–§10, C-14). No `CLOSED`, no `TIMEOUT` state — timeout is an
// event (`ORDER_TIMEOUT`), closing a position is a separate reduce-only order.
// ---------------------------------------------------------------------------
export const ORDER_STATES = [
  'CREATED',
  'SUBMITTED',
  'ACKNOWLEDGED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCEL_REQUESTED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const ORDER_TERMINAL_STATES = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const;

export const ORDER_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  CREATED: ['SUBMITTED'],
  SUBMITTED: ['ACKNOWLEDGED', 'REJECTED'],
  ACKNOWLEDGED: ['PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCEL_REQUESTED', 'EXPIRED'],
  PARTIALLY_FILLED: ['FILLED', 'CANCEL_REQUESTED', 'EXPIRED'],
  CANCEL_REQUESTED: ['CANCELED', 'FILLED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
};

// ---------------------------------------------------------------------------
// Trade (spec §26.2)
// ---------------------------------------------------------------------------
export const TRADE_STATUSES = [
  'CREATED',
  'PRE_FLIGHT',
  'ENTRY_PENDING',
  'PARTIALLY_HEDGED',
  'LEG_IMBALANCE',
  'HEDGED',
  'EXIT_PENDING',
  'EMERGENCY_EXIT',
  'CLOSED',
  'ABORTED',
  'FAILED',
] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];
export const TRADE_TERMINAL_STATUSES = ['CLOSED', 'ABORTED', 'FAILED'] as const;

const TRADE_NON_FAILED_TRANSITIONS: Record<TradeStatus, readonly TradeStatus[]> = {
  CREATED: ['PRE_FLIGHT'],
  PRE_FLIGHT: ['ENTRY_PENDING', 'ABORTED'],
  ENTRY_PENDING: ['HEDGED', 'PARTIALLY_HEDGED', 'LEG_IMBALANCE', 'ABORTED'],
  PARTIALLY_HEDGED: ['HEDGED', 'LEG_IMBALANCE'],
  LEG_IMBALANCE: ['EMERGENCY_EXIT'],
  HEDGED: ['EXIT_PENDING', 'EMERGENCY_EXIT'],
  EXIT_PENDING: ['CLOSED'],
  EMERGENCY_EXIT: ['CLOSED'],
  CLOSED: [],
  ABORTED: [],
  FAILED: [],
};

// Any non-terminal status can additionally transition to FAILED (spec §26.2).
export const TRADE_TRANSITIONS: Record<TradeStatus, readonly TradeStatus[]> = Object.fromEntries(
  TRADE_STATUSES.map((s) => {
    const base = TRADE_NON_FAILED_TRANSITIONS[s];
    const withFailed = TRADE_TERMINAL_STATUSES.includes(s as (typeof TRADE_TERMINAL_STATUSES)[number])
      ? base
      : [...base, 'FAILED' as const].filter((v, i, arr) => arr.indexOf(v) === i);
    return [s, withFailed];
  }),
) as Record<TradeStatus, readonly TradeStatus[]>;

// ---------------------------------------------------------------------------
// Opportunity (spec §26.1)
// ---------------------------------------------------------------------------
export const OPPORTUNITY_STATUSES = ['DETECTED', 'QUALIFIED', 'SELECTED', 'REJECTED', 'EXPIRED'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export const OPPORTUNITY_TERMINAL_STATUSES = ['SELECTED', 'REJECTED', 'EXPIRED'] as const;

export const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, readonly OpportunityStatus[]> = {
  DETECTED: ['QUALIFIED', 'REJECTED', 'EXPIRED'],
  QUALIFIED: ['SELECTED', 'REJECTED', 'EXPIRED'],
  SELECTED: [],
  REJECTED: [],
  EXPIRED: [],
};

// ---------------------------------------------------------------------------
// Leg (spec §26.3; no transition diagram in spec, derived per design.md
// Decision/Open Question 2 — PARTIAL -> CLOSING is used for emergency close).
// ---------------------------------------------------------------------------
export const LEG_STATUSES = ['PENDING', 'OPENING', 'PARTIAL', 'OPEN', 'CLOSING', 'CLOSED', 'FAILED'] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];
export const LEG_TERMINAL_STATUSES = ['CLOSED', 'FAILED'] as const;

export const LEG_TRANSITIONS: Record<LegStatus, readonly LegStatus[]> = {
  PENDING: ['OPENING', 'FAILED'],
  OPENING: ['PARTIAL', 'OPEN', 'FAILED'],
  PARTIAL: ['OPEN', 'CLOSING'],
  OPEN: ['CLOSING'],
  CLOSING: ['CLOSED', 'FAILED'],
  CLOSED: [],
  FAILED: [],
};

// ---------------------------------------------------------------------------
// FundingSettlement (spec §18)
// ---------------------------------------------------------------------------
export const FUNDING_SETTLEMENT_STATUSES = ['EXPECTED', 'ELIGIBLE', 'SETTLED', 'NOT_ELIGIBLE', 'MISSED'] as const;
export type FundingSettlementStatus = (typeof FUNDING_SETTLEMENT_STATUSES)[number];
export const FUNDING_SETTLEMENT_TERMINAL_STATUSES = ['SETTLED', 'NOT_ELIGIBLE', 'MISSED'] as const;

export const FUNDING_SETTLEMENT_TRANSITIONS: Record<FundingSettlementStatus, readonly FundingSettlementStatus[]> = {
  EXPECTED: ['ELIGIBLE', 'NOT_ELIGIBLE'],
  ELIGIBLE: ['SETTLED', 'MISSED', 'NOT_ELIGIBLE'],
  SETTLED: [],
  NOT_ELIGIBLE: [],
  MISSED: [],
};

// ---------------------------------------------------------------------------
// isAllowedTransition / transitionEventType
// ---------------------------------------------------------------------------
export type TransitionEntityKind = 'ORDER' | 'TRADE' | 'LEG' | 'OPPORTUNITY' | 'FUNDING_SETTLEMENT';

type StateOf<E extends TransitionEntityKind> = E extends 'ORDER'
  ? OrderState
  : E extends 'TRADE'
    ? TradeStatus
    : E extends 'LEG'
      ? LegStatus
      : E extends 'OPPORTUNITY'
        ? OpportunityStatus
        : FundingSettlementStatus;

const TRANSITION_TABLES: Record<TransitionEntityKind, Record<string, readonly string[]>> = {
  ORDER: ORDER_TRANSITIONS,
  TRADE: TRADE_TRANSITIONS,
  LEG: LEG_TRANSITIONS,
  OPPORTUNITY: OPPORTUNITY_TRANSITIONS,
  FUNDING_SETTLEMENT: FUNDING_SETTLEMENT_TRANSITIONS,
};

export function isAllowedTransition<E extends TransitionEntityKind>(
  entity: E,
  from: StateOf<E>,
  to: StateOf<E>,
): boolean {
  const table = TRANSITION_TABLES[entity];
  const targets = table[from as string];
  return targets !== undefined && targets.includes(to as string);
}

export function transitionEventType<E extends TransitionEntityKind>(
  entity: E,
  from: StateOf<E>,
  to: StateOf<E>,
): TradingEventType {
  switch (entity) {
    case 'ORDER': {
      const f = from as OrderState;
      const t = to as OrderState;
      const leavingCancelRequested = f === 'CANCEL_REQUESTED' && (t === 'ACKNOWLEDGED' || t === 'PARTIALLY_FILLED');
      if (leavingCancelRequested) return 'ORDER_CANCEL_REJECTED';
      switch (t) {
        case 'SUBMITTED':
          return 'ORDER_SUBMITTED';
        case 'ACKNOWLEDGED':
          return 'ORDER_ACK';
        case 'PARTIALLY_FILLED':
          return 'ORDER_PARTIAL_FILL';
        case 'FILLED':
          return 'ORDER_FILL';
        case 'CANCEL_REQUESTED':
          return 'ORDER_CANCEL_REQUESTED';
        case 'CANCELED':
          return 'ORDER_CANCELED';
        case 'REJECTED':
          return 'ORDER_REJECTED';
        case 'EXPIRED':
          return 'ORDER_EXPIRED';
        default:
          throw new Error(`transitionEventType: no event mapping for ORDER -> ${t}`);
      }
    }
    case 'TRADE':
      return 'TRADE_STATUS_CHANGED';
    case 'LEG':
      return 'LEG_STATUS_CHANGED';
    case 'OPPORTUNITY': {
      const t = to as OpportunityStatus;
      return `OPPORTUNITY_${t}` as TradingEventType;
    }
    case 'FUNDING_SETTLEMENT': {
      const t = to as FundingSettlementStatus;
      return t === 'SETTLED' ? 'FUNDING_SETTLED' : 'FUNDING_STATUS_CHANGED';
    }
    default:
      throw new Error(`transitionEventType: unknown entity ${String(entity)}`);
  }
}
