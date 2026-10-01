import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import { DEFAULT_VENUE_RULES } from '../venue/venueRules';
import { DEFAULT_SESSION_TIMING, type SettlementLeg } from './types';
import { computeTimetable, validateSessionTimingConfig } from './timetable';

function zeroedClock(start = 0) {
  const clock = new VirtualClock(start);
  for (const ex of ['Binance', 'Bybit', 'OKX'] as const) {
    clock.setExchangeOffset(ex, { offsetMs: 0, errorMs: 0, calibratedAt: start });
  }
  return clock;
}

describe('computeTimetable (settlement-session spec)', () => {
  it('Binance x Bybit defaults', () => {
    const T = 1_000_000;
    const clock = zeroedClock();
    const legs: [SettlementLeg, SettlementLeg] = [{ exchange: 'Binance' }, { exchange: 'Bybit' }];
    const venueRules = (ex: SettlementLeg['exchange']) => DEFAULT_VENUE_RULES[ex]!;

    const timetable = computeTimetable(T, legs, clock, venueRules, DEFAULT_SESSION_TIMING);

    expect(timetable.entryDeadline).toBe(T - 25_000);
    expect(timetable.hedgedBy).toBe(T - 15_000);
    expect(timetable.lockEnd).toBe(T + 15_000);
    expect(timetable.exitAt).toBe(T + 30_000);
  });

  it('wider venue window propagates (OKX leg)', () => {
    const T = 1_000_000;
    const clock = zeroedClock();
    const legs: [SettlementLeg, SettlementLeg] = [{ exchange: 'OKX' }, { exchange: 'Binance' }];
    const venueRules = (ex: SettlementLeg['exchange']) => DEFAULT_VENUE_RULES[ex]!;

    const timetable = computeTimetable(T, legs, clock, venueRules, DEFAULT_SESSION_TIMING);

    expect(timetable.lockEnd).toBe(T + 60_000);
    expect(timetable.exitAt).toBe(T + 75_000);
  });

  it('uses each leg own exchange clock and error bound, conservatively combined (trading-clock Decision 3)', () => {
    const T = 1_000_000;
    const clock = new VirtualClock(0);
    clock.setExchangeOffset('Binance', { offsetMs: 0, errorMs: 0, calibratedAt: 0 });
    clock.setExchangeOffset('Bybit', { offsetMs: -30, errorMs: 10, calibratedAt: 0 });
    clock.setExchangeOffset('OKX', { offsetMs: 40, errorMs: 20, calibratedAt: 0 });
    const legs: [SettlementLeg, SettlementLeg] = [{ exchange: 'Bybit' }, { exchange: 'OKX' }];
    const venueRules = (ex: SettlementLeg['exchange']) => DEFAULT_VENUE_RULES[ex]!;

    const timetable = computeTimetable(T, legs, clock, venueRules, DEFAULT_SESSION_TIMING);

    const expected = Math.max(
      clock.toLocal('Bybit', T + 5_000) + 10,
      clock.toLocal('OKX', T + 60_000) + 20,
    );
    expect(timetable.lockEnd).toBe(expected);
  });
});

describe('validateSessionTimingConfig (settlement-session spec)', () => {
  it('accepts the defaults', () => {
    const result = validateSessionTimingConfig(DEFAULT_SESSION_TIMING, 15_000);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects entry_deadline <= entry_open', () => {
    const config = { ...DEFAULT_SESSION_TIMING, entryOpenLeadMs: 10_000 }; // too small vs guard+buffers
    const result = validateSessionTimingConfig(config, 15_000);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/entryDeadline|entryOpen/);
  });

  it('rejects entry_open >= arm_at', () => {
    const config = { ...DEFAULT_SESSION_TIMING, entryOpenLeadMs: 60_000, armLeadMs: 60_000 };
    const result = validateSessionTimingConfig(config, 15_000);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/entryOpen|armAt/);
  });
});
