import { describe, expect, it } from 'vitest';
import { makeTransitionEvent, IllegalTransitionError, NO_TRADE_EVENT_TYPES, TRADING_EVENT_TYPES } from './event';

const fixedClock = (t: number) => ({ now: () => t });

describe('TradingEventType', () => {
  it('does not include KILL_SWITCH_* codes (C-16 not implemented)', () => {
    expect(TRADING_EVENT_TYPES.some((c) => c.startsWith('KILL_SWITCH'))).toBe(false);
  });

  it('includes instrument-registry and event-loop extension codes', () => {
    for (const code of [
      'INSTRUMENT_LISTED',
      'INSTRUMENT_STATUS_CHANGED',
      'INSTRUMENT_SPEC_CHANGED',
      'FUNDING_SCHEDULE_CHANGED',
      'INSTRUMENT_AMBIGUOUS',
      'INSTRUMENT_UNKNOWN_VALUE',
      'INSTRUMENT_SOURCE_STATUS_CHANGED',
      'SESSION_PHASE_CHANGED',
      'CLOCK_REFERENCE_CHANGED',
      'CLOCK_OFFSET_JUMP',
    ]) {
      expect(TRADING_EVENT_TYPES).toContain(code);
    }
  });
});

describe('makeTransitionEvent', () => {
  it('builds a TRADE_STATUS_CHANGED event with from/to/reason/after', () => {
    const before = { trade_id: 't1', status: 'ENTRY_PENDING' };
    const after = { trade_id: 't1', status: 'HEDGED' };
    const evt = makeTransitionEvent('TRADE', before, after, 'HEDGE_RATIO_OK', fixedClock(1_700_000_000_095));
    expect(evt.event_type).toBe('TRADE_STATUS_CHANGED');
    expect(evt.timestamp).toBe(1_700_000_000_095);
    expect(evt.payload.from).toBe('ENTRY_PENDING');
    expect(evt.payload.to).toBe('HEDGED');
    expect(evt.payload.reason).toBe('HEDGE_RATIO_OK');
    expect((evt.payload.after as typeof after).status).toBe('HEDGED');
    expect(evt.trade_id).toBe('t1');
  });

  it('throws IllegalTransitionError naming FILLED -> CANCELED', () => {
    expect(() =>
      makeTransitionEvent(
        'ORDER',
        { order_state: 'FILLED' },
        { order_state: 'CANCELED' },
        'x',
        fixedClock(0),
      ),
    ).toThrow(IllegalTransitionError);
    try {
      makeTransitionEvent('ORDER', { order_state: 'FILLED' }, { order_state: 'CANCELED' }, 'x', fixedClock(0));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('FILLED');
      expect((e as Error).message).toContain('CANCELED');
    }
  });

  it('opportunity events have null trade_id, present in NO_TRADE_EVENT_TYPES', () => {
    const evt = makeTransitionEvent(
      'OPPORTUNITY',
      { opportunity_id: 'o1', status: 'DETECTED' },
      { opportunity_id: 'o1', status: 'QUALIFIED' },
      'COST_OK',
      fixedClock(1),
    );
    expect(evt.trade_id).toBeNull();
    expect(NO_TRADE_EVENT_TYPES.has(evt.event_type)).toBe(true);
  });
});
