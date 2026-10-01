import { describe, expect, it } from 'vitest';
import {
  ORDER_STATES,
  TRADE_STATUSES,
  LEG_STATUSES,
  OPPORTUNITY_STATUSES,
  FUNDING_SETTLEMENT_STATUSES,
  ORDER_TERMINAL_STATES,
  TRADE_TERMINAL_STATUSES,
  LEG_TERMINAL_STATUSES,
  OPPORTUNITY_TERMINAL_STATUSES,
  FUNDING_SETTLEMENT_TERMINAL_STATUSES,
  isAllowedTransition,
  transitionEventType,
  ORDER_TRANSITIONS,
  TRADE_TRANSITIONS,
  LEG_TRANSITIONS,
  OPPORTUNITY_TRANSITIONS,
  FUNDING_SETTLEMENT_TRANSITIONS,
} from './status';

describe('status enums', () => {
  it('ORDER_STATES has no CLOSED and no TIMEOUT', () => {
    expect(ORDER_STATES).not.toContain('CLOSED');
    expect(ORDER_STATES).not.toContain('TIMEOUT');
  });

  it('every *_STATES set is non-empty and terminal subset is contained in it', () => {
    for (const [states, terminal] of [
      [ORDER_STATES, ORDER_TERMINAL_STATES],
      [TRADE_STATUSES, TRADE_TERMINAL_STATUSES],
      [LEG_STATUSES, LEG_TERMINAL_STATUSES],
      [OPPORTUNITY_STATUSES, OPPORTUNITY_TERMINAL_STATUSES],
      [FUNDING_SETTLEMENT_STATUSES, FUNDING_SETTLEMENT_TERMINAL_STATUSES],
    ] as const) {
      expect(states.length).toBeGreaterThan(0);
      for (const t of terminal) {
        expect(states).toContain(t);
      }
    }
  });
});

describe('transition tables are exhaustive (no dangling targets)', () => {
  function assertExhaustive(allStates: readonly string[], table: Record<string, readonly string[]>) {
    for (const from of Object.keys(table)) {
      expect(allStates).toContain(from);
      for (const to of table[from]) {
        expect(allStates).toContain(to);
      }
    }
  }

  it('ORDER_TRANSITIONS', () => assertExhaustive(ORDER_STATES, ORDER_TRANSITIONS));
  it('TRADE_TRANSITIONS', () => assertExhaustive(TRADE_STATUSES, TRADE_TRANSITIONS));
  it('LEG_TRANSITIONS', () => assertExhaustive(LEG_STATUSES, LEG_TRANSITIONS));
  it('OPPORTUNITY_TRANSITIONS', () => assertExhaustive(OPPORTUNITY_STATUSES, OPPORTUNITY_TRANSITIONS));
  it('FUNDING_SETTLEMENT_TRANSITIONS', () =>
    assertExhaustive(FUNDING_SETTLEMENT_STATUSES, FUNDING_SETTLEMENT_TRANSITIONS));
});

describe('isAllowedTransition', () => {
  it('Order cannot be CLOSED (unknown target -> false at runtime)', () => {
    expect(isAllowedTransition('ORDER', 'FILLED', 'CLOSED' as never)).toBe(false);
  });

  it('terminal order states are final', () => {
    expect(isAllowedTransition('ORDER', 'CANCELED', 'FILLED')).toBe(false);
  });

  it('cancel-rejected revert allowed', () => {
    expect(isAllowedTransition('ORDER', 'CANCEL_REQUESTED', 'PARTIALLY_FILLED')).toBe(true);
    expect(isAllowedTransition('ORDER', 'CANCEL_REQUESTED', 'ACKNOWLEDGED')).toBe(true);
  });

  it('any non-terminal trade status can go to FAILED, terminal ones cannot', () => {
    for (const s of TRADE_STATUSES) {
      const expected = !(TRADE_TERMINAL_STATUSES as readonly string[]).includes(s);
      expect(isAllowedTransition('TRADE', s, 'FAILED')).toBe(expected);
    }
  });

  it('trade cannot skip hedge', () => {
    expect(isAllowedTransition('TRADE', 'ENTRY_PENDING', 'EXIT_PENDING')).toBe(false);
  });
});

describe('transitionEventType', () => {
  it('every allowed transition of every table maps to a defined event code', () => {
    const tables: Array<
      [
        'ORDER' | 'TRADE' | 'LEG' | 'OPPORTUNITY' | 'FUNDING_SETTLEMENT',
        Record<string, readonly string[]>,
      ]
    > = [
      ['ORDER', ORDER_TRANSITIONS],
      ['TRADE', TRADE_TRANSITIONS],
      ['LEG', LEG_TRANSITIONS],
      ['OPPORTUNITY', OPPORTUNITY_TRANSITIONS],
      ['FUNDING_SETTLEMENT', FUNDING_SETTLEMENT_TRANSITIONS],
    ];
    for (const [entity, table] of tables) {
      for (const from of Object.keys(table)) {
        for (const to of table[from]) {
          const code = transitionEventType(entity as never, from as never, to as never);
          expect(code).toBeDefined();
          expect(typeof code).toBe('string');
        }
      }
    }
  });

  it('order ack vs cancel-reject disambiguation', () => {
    expect(transitionEventType('ORDER', 'SUBMITTED', 'ACKNOWLEDGED')).toBe('ORDER_ACK');
    expect(transitionEventType('ORDER', 'CANCEL_REQUESTED', 'ACKNOWLEDGED')).toBe('ORDER_CANCEL_REJECTED');
    expect(transitionEventType('ORDER', 'CANCEL_REQUESTED', 'PARTIALLY_FILLED')).toBe('ORDER_CANCEL_REJECTED');
  });

  it('funding settlement: SETTLED vs others', () => {
    expect(transitionEventType('FUNDING_SETTLEMENT', 'ELIGIBLE', 'SETTLED')).toBe('FUNDING_SETTLED');
    expect(transitionEventType('FUNDING_SETTLEMENT', 'EXPECTED', 'ELIGIBLE')).toBe('FUNDING_STATUS_CHANGED');
  });

  it('opportunity: OPPORTUNITY_<TO>', () => {
    expect(transitionEventType('OPPORTUNITY', 'DETECTED', 'QUALIFIED')).toBe('OPPORTUNITY_QUALIFIED');
    expect(transitionEventType('OPPORTUNITY', 'QUALIFIED', 'SELECTED')).toBe('OPPORTUNITY_SELECTED');
  });
});
