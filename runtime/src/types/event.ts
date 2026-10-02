/**
 * runtime/src/types/event.ts
 *
 * `TradingEventType` (tech spec §26 core codes + extension codes, design.md
 * Decision 4 / Open Question 3) and `TradingEvent` (tech spec §27 + additive
 * fields, design.md Decision 2). `makeTransitionEvent` builds a state-
 * transition event and refuses illegal transitions.
 */
import type { ExchangeId } from './ids';
import { isAllowedTransition, transitionEventType, type TransitionEntityKind } from './status';

/**
 * Core event codes — tech spec §26.
 */
const CORE_EVENT_TYPES = [
  'OPPORTUNITY_DETECTED',
  'OPPORTUNITY_QUALIFIED',
  'OPPORTUNITY_SELECTED',
  'OPPORTUNITY_REJECTED',
  'OPPORTUNITY_EXPIRED',
  'TRADE_CREATED',
  'TRADE_STATUS_CHANGED',
  'RISK_CHECK_STARTED',
  'RISK_CHECK_PASSED',
  'RISK_CHECK_FAILED',
  'ORDER_CREATED',
  'ORDER_SUBMITTED',
  'ORDER_ACK',
  'ORDER_ACK_TIMEOUT',
  'ORDER_PARTIAL_FILL',
  'ORDER_FILL',
  'ORDER_TIMEOUT',
  'ORDER_CANCEL_REQUESTED',
  'ORDER_CANCELED',
  'ORDER_CANCEL_REJECTED',
  'ORDER_REJECTED',
  'ORDER_EXPIRED',
  'HEDGE_RATIO_CHANGED',
  'LEG_IMBALANCE_DETECTED',
  'EMERGENCY_EXIT_STARTED',
  'POSITION_OPENED',
  'FUNDING_SETTLED',
  'EXIT_STARTED',
  'POSITION_CLOSED',
  'TRADE_COMPLETED',
  'RECONCILIATION_ERROR',
  'STALE_MARKET_DATA',
  'EXCHANGE_DISCONNECTED',
] as const;

/**
 * Extension codes owned by `trading-schema-types` — needed to make every
 * allowed transition of every table map to an event code (design.md
 * Decision 4 / Open Question 3).
 */
const SCHEMA_EXTENSION_EVENT_TYPES = [
  'LEG_STATUS_CHANGED',
  'FUNDING_STATUS_CHANGED',
  'CAPITAL_RESERVED',
  'CAPITAL_RELEASED',
  'ENTRY_HALT_REQUESTED',
  'ENTRY_HALT_CLEARED',
  'RUNTIME_STARTUP_STEP',
  'RUNTIME_ARMED',
  'RUNTIME_DISARMED',
] as const;

/**
 * Extension codes reserved for `paper-trading-event-loop` (cross-change
 * coordination, design.md assumption; first-merged change adds the codes).
 */
const EVENT_LOOP_EXTENSION_EVENT_TYPES = [
  'SESSION_PHASE_CHANGED',
  'CLOCK_REFERENCE_CHANGED',
  'CLOCK_OFFSET_JUMP',
] as const;

/**
 * Extension codes reserved for `instrument-registry` (cross-change
 * coordination; first-merged change adds the codes and glossary entries).
 */
const INSTRUMENT_REGISTRY_EXTENSION_EVENT_TYPES = [
  'INSTRUMENT_LISTED',
  'INSTRUMENT_STATUS_CHANGED',
  'INSTRUMENT_SPEC_CHANGED',
  'FUNDING_SCHEDULE_CHANGED',
  'INSTRUMENT_AMBIGUOUS',
  'INSTRUMENT_UNKNOWN_VALUE',
  'INSTRUMENT_SOURCE_STATUS_CHANGED',
] as const;

/**
 * Extension codes owned by `websocket-data-layer` (design.md Decision 9 /
 * cross-change assumption B5).
 */
const MARKET_DATA_LAYER_EXTENSION_EVENT_TYPES = [
  'FEED_STATE_CHANGED',
  'MARKET_DATA_RECOVERED',
  'ORDER_BOOK_RESYNC',
  'SOURCE_STATUS_CHANGED',
  'RATE_LIMIT_CIRCUIT_CHANGED',
  'SHORTLIST_SUBSCRIPTION_DROPPED',
] as const;

/**
 * Kill Switch event codes (C-16, decided 2026-10-02; design.md §6–§7 /
 * tasks.md group 4). These replace the tech spec §26 `KILL_SWITCH_*`
 * placeholder with the concrete six codes this change implements.
 */
const KILL_SWITCH_EVENT_TYPES = [
  'KILL_SWITCH_ACTIVATED',
  'KILL_SWITCH_RELEASED',
  'KILL_SWITCH_TRIGGERED',
  'KILL_SWITCH_FLATTEN_REQUESTED',
  'KILL_SWITCH_FLATTEN_REJECTED',
  'KILL_SWITCH_CANCEL_FAILED',
] as const;

export const TRADING_EVENT_TYPES = [
  ...CORE_EVENT_TYPES,
  ...SCHEMA_EXTENSION_EVENT_TYPES,
  ...EVENT_LOOP_EXTENSION_EVENT_TYPES,
  ...INSTRUMENT_REGISTRY_EXTENSION_EVENT_TYPES,
  ...MARKET_DATA_LAYER_EXTENSION_EVENT_TYPES,
  ...KILL_SWITCH_EVENT_TYPES,
] as const;

export type TradingEventType = (typeof TRADING_EVENT_TYPES)[number];

/**
 * tech spec §27 fields + additive `opportunity_id?`, `session_id?`,
 * `clock_reference?` (design.md Decision 2). `trade_id` is `string | null`
 * because tech spec §26 itself lists event types with no trade in scope
 * (`OPPORTUNITY_*`, `STALE_MARKET_DATA`, …) — a required `string` would
 * contradict that list.
 */
export interface TradingEvent {
  event_id: string;
  event_type: TradingEventType;
  timestamp: number;
  trade_id: string | null;
  leg_id?: string;
  order_id?: string;
  position_id?: string;
  opportunity_id?: string;
  session_id?: string;
  exchange?: ExchangeId;
  symbol?: string;
  /** MUST NOT contain any API credential — see `assertNoCredentials` (Invariant #2). */
  payload: Record<string, unknown>;
  recorded_at: number;
  clock_offset_ms?: number;
  clock_reference?: ExchangeId;
}

/** Event types for which `trade_id` is allowed to be `null`. */
export const NO_TRADE_EVENT_TYPES: ReadonlySet<TradingEventType> = new Set([
  'OPPORTUNITY_DETECTED',
  'OPPORTUNITY_QUALIFIED',
  'OPPORTUNITY_SELECTED',
  'OPPORTUNITY_REJECTED',
  'OPPORTUNITY_EXPIRED',
  'SESSION_PHASE_CHANGED',
  'CLOCK_REFERENCE_CHANGED',
  'CLOCK_OFFSET_JUMP',
  'STALE_MARKET_DATA',
  'EXCHANGE_DISCONNECTED',
  'RUNTIME_STARTUP_STEP',
  'RUNTIME_ARMED',
  'RUNTIME_DISARMED',
  'ENTRY_HALT_REQUESTED',
  'ENTRY_HALT_CLEARED',
  'RECONCILIATION_ERROR',
  'INSTRUMENT_LISTED',
  'INSTRUMENT_STATUS_CHANGED',
  'INSTRUMENT_SPEC_CHANGED',
  'FUNDING_SCHEDULE_CHANGED',
  'INSTRUMENT_AMBIGUOUS',
  'INSTRUMENT_UNKNOWN_VALUE',
  'INSTRUMENT_SOURCE_STATUS_CHANGED',
  'FEED_STATE_CHANGED',
  'MARKET_DATA_RECOVERED',
  'ORDER_BOOK_RESYNC',
  'SOURCE_STATUS_CHANGED',
  'RATE_LIMIT_CIRCUIT_CHANGED',
  'SHORTLIST_SUBSCRIPTION_DROPPED',
  'KILL_SWITCH_ACTIVATED',
  'KILL_SWITCH_RELEASED',
  'KILL_SWITCH_TRIGGERED',
  'KILL_SWITCH_FLATTEN_REQUESTED',
  'KILL_SWITCH_FLATTEN_REJECTED',
  'KILL_SWITCH_CANCEL_FAILED',
]);

export class IllegalTransitionError extends Error {
  constructor(entity: TransitionEntityKind, from: string, to: string) {
    super(`Illegal ${entity} transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Minimal clock contract — `paper-trading-event-loop` owns the full `Clock` interface. */
export interface EventClock {
  now(): number;
}

interface StatusBearing {
  status?: string;
  order_state?: string;
  settlement_status?: string;
  trade_id?: string;
  leg_id?: string;
  order_id?: string;
  opportunity_id?: string;
}

function stateOf(entity: TransitionEntityKind, value: StatusBearing): string | undefined {
  if (entity === 'ORDER') return value.order_state;
  if (entity === 'FUNDING_SETTLEMENT') return value.settlement_status;
  return value.status;
}

function idsOf(entity: TransitionEntityKind, value: StatusBearing) {
  return {
    trade_id: entity === 'OPPORTUNITY' ? null : (value.trade_id ?? null),
    leg_id: entity === 'LEG' || entity === 'ORDER' || entity === 'FUNDING_SETTLEMENT' ? value.leg_id : undefined,
    order_id: entity === 'ORDER' ? value.order_id : undefined,
    opportunity_id: entity === 'OPPORTUNITY' ? value.opportunity_id : undefined,
  };
}

/**
 * Builds a `TradingEvent` for an entity state transition (design.md Decision
 * 4): `payload.from`, `payload.to`, `payload.reason`, `payload.after` (the
 * full post-transition entity snapshot). Throws `IllegalTransitionError` if
 * the transition is not allowed by the entity's transition table. `event_id`
 * is generated with `crypto.randomUUID()` (not system time, allowed under
 * the runtime architecture guard).
 */
export function makeTransitionEvent<T extends StatusBearing & Record<string, unknown>>(
  entity: TransitionEntityKind,
  before: T,
  after: T,
  reason: string,
  clock: EventClock,
): TradingEvent {
  const from = stateOf(entity, before);
  const to = stateOf(entity, after);
  if (from === undefined || to === undefined || !isAllowedTransition(entity, from as never, to as never)) {
    throw new IllegalTransitionError(entity, String(from), String(to));
  }
  const event_type = transitionEventType(entity, from as never, to as never);
  const timestamp = clock.now();
  const ids = idsOf(entity, after);
  return {
    event_id: crypto.randomUUID(),
    event_type,
    timestamp,
    trade_id: ids.trade_id,
    leg_id: ids.leg_id,
    order_id: ids.order_id,
    opportunity_id: ids.opportunity_id,
    payload: { from, to, reason, after },
    recorded_at: timestamp,
  };
}
