import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import { DEFAULT_VENUE_RULES } from '../venue/venueRules';
import { DEFAULT_SESSION_TIMING, type SettlementLeg } from './types';
import { computeTimetable } from './timetable';
import { SettlementSession } from './settlementSession';

function buildSession(clock: VirtualClock, hasValidOpportunity: () => boolean) {
  const T = clock.now() + 31 * 60_000;
  const legs: [SettlementLeg, SettlementLeg] = [{ exchange: 'Binance' }, { exchange: 'Bybit' }];
  const venueRules = (ex: SettlementLeg['exchange']) => DEFAULT_VENUE_RULES[ex]!;
  const timetable = computeTimetable(T, legs, clock, venueRules, DEFAULT_SESSION_TIMING);
  const session = new SettlementSession(T, timetable, clock, { hasValidOpportunity });
  return { session, T, timetable };
}

function zeroedClock(start = 0) {
  const clock = new VirtualClock(start);
  for (const ex of ['Binance', 'Bybit', 'OKX'] as const) {
    clock.setExchangeOffset(ex, { offsetMs: 0, errorMs: 0, calibratedAt: start });
  }
  return clock;
}

describe('SettlementSession (settlement-session spec)', () => {
  it('passes WATCH, SHORTLIST, ARM, ENTRY, LOCK, CONFIRM in order, one event per transition', () => {
    const clock = zeroedClock(0);
    const { session, T, timetable } = buildSession(clock, () => true);

    expect(session.phase).toBe('WATCH');

    clock.advanceTo(T + 31_000);

    expect(session.phase).toBe('CONFIRM');
    const phases = session.events().map((e) => e.to);
    expect(phases).toEqual(['SHORTLIST', 'ARM', 'ENTRY', 'LOCK', 'CONFIRM']);
    expect(session.events().every((e) => e.type === 'SESSION_PHASE_CHANGED')).toBe(true);
    void timetable;
  });

  it('transitions to SKIPPED with NO_VALID_OPPORTUNITY when nothing qualifies at arm_at, and stops further transitions', () => {
    const clock = zeroedClock(0);
    const { session, T } = buildSession(clock, () => false);

    clock.advanceTo(T + 31_000);

    expect(session.phase).toBe('SKIPPED');
    const last = session.events().at(-1)!;
    expect(last).toMatchObject({ to: 'SKIPPED', reason: 'NO_VALID_OPPORTUNITY' });
    // no ENTRY/LOCK/CONFIRM after SKIPPED
    expect(session.events().map((e) => e.to)).not.toContain('ENTRY');
  });
});
