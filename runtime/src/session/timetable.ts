import type { Clock } from '../clock/types';
import type { VenueRule } from '../venue/types';
import type { PhaseTimetable, SessionTimingConfig, SettlementLeg } from './types';

/**
 * Convert one exchange-time value (computed per leg) to local scheduling time, widened by that
 * leg's error bound, and combine conservatively across legs: earliest for "before T" deadlines,
 * latest for "after T" deadlines (trading-clock spec "Decisions use each leg's own exchange
 * clock"; settlement-session spec "Phase timetable derived from config and venue rules").
 */
function combineLocal(
  legs: readonly SettlementLeg[],
  clock: Clock,
  exchangeTimeFor: (leg: SettlementLeg) => number,
  direction: 'earliest' | 'latest',
): number {
  const localTimes = legs.map((leg) => {
    const { errorMs } = clock.offset(leg.exchange);
    const local = clock.toLocal(leg.exchange, exchangeTimeFor(leg));
    return direction === 'earliest' ? local - errorMs : local + errorMs;
  });
  return direction === 'earliest' ? Math.min(...localTimes) : Math.max(...localTimes);
}

/**
 * Compute a session's phase timetable for settlement time `T` (settlement-session spec
 * "Phase timetable derived from config and venue rules"). `T` is the funding time in epoch ms,
 * read directly as each leg's own exchange-time axis value (legs are expected to already be
 * alignment-checked — see contract-eligibility).
 */
export function computeTimetable(
  T: number,
  legs: readonly [SettlementLeg, SettlementLeg],
  clock: Clock,
  venueRuleFor: (exchange: SettlementLeg['exchange']) => VenueRule,
  config: SessionTimingConfig,
): PhaseTimetable {
  const watchStart = combineLocal(legs, clock, () => T - config.watchLeadMs, 'earliest');
  const shortlistAt = combineLocal(legs, clock, () => T - config.shortlistLeadMs, 'earliest');
  const armAt = combineLocal(legs, clock, () => T - config.armLeadMs, 'earliest');
  const entryOpen = combineLocal(legs, clock, () => T - config.entryOpenLeadMs, 'earliest');
  const entryDeadline = combineLocal(
    legs,
    clock,
    (leg) =>
      T - venueRuleFor(leg.exchange).guardBeforeMs - config.partialHedgeMaxDurationMs - config.entryBufferMs,
    'earliest',
  );
  const hedgedBy = combineLocal(
    legs,
    clock,
    (leg) => T - venueRuleFor(leg.exchange).guardBeforeMs,
    'earliest',
  );
  const lockEnd = combineLocal(
    legs,
    clock,
    (leg) => T + venueRuleFor(leg.exchange).guardAfterMs,
    'latest',
  );
  const exitAt = lockEnd + config.exitBufferMs;

  return { watchStart, shortlistAt, armAt, entryOpen, entryDeadline, hedgedBy, lockEnd, exitAt };
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Startup validation (settlement-session spec "Invalid config rejected"): checks the config
 * against the worst case (largest configured `guardBeforeMs`) rather than any single pair, since
 * venue rules vary per pair and this check runs once at startup.
 */
export function validateSessionTimingConfig(
  config: SessionTimingConfig,
  maxGuardBeforeMs: number,
): ConfigValidationResult {
  const errors: string[] = [];
  const worstCaseEntryDeadlineLeadMs =
    maxGuardBeforeMs + config.partialHedgeMaxDurationMs + config.entryBufferMs;

  // entry_deadline must be strictly after entry_open (entry window must be non-empty).
  if (worstCaseEntryDeadlineLeadMs >= config.entryOpenLeadMs) {
    errors.push(
      `entryDeadline (T-${worstCaseEntryDeadlineLeadMs}ms worst case) must be after entryOpen (T-${config.entryOpenLeadMs}ms): increase entryOpenLeadMs or decrease guard/buffer fields`,
    );
  }

  // entry_open must be strictly after arm_at (ARM must finish before the entry window opens).
  if (config.entryOpenLeadMs >= config.armLeadMs) {
    errors.push(
      `entryOpen (T-${config.entryOpenLeadMs}ms) must be after armAt (T-${config.armLeadMs}ms): increase armLeadMs or decrease entryOpenLeadMs`,
    );
  }

  return { valid: errors.length === 0, errors };
}
