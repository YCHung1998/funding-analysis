import { describe, expect, it } from 'vitest';
import { ALL_CHECKS, ENTRY_CHECKS, POSITION_CHECKS, PRE_TRADE_CHECKS, findCheck } from './registry';

describe('risk check registry', () => {
  it('has 15 Pre-Trade + 7 Entry + 6 Position = 28 checks total', () => {
    expect(PRE_TRADE_CHECKS).toHaveLength(15);
    expect(ENTRY_CHECKS).toHaveLength(7);
    expect(POSITION_CHECKS).toHaveLength(6);
    expect(ALL_CHECKS).toHaveLength(28);
  });

  it('Pre-Trade order matches spec failed_reasons order', () => {
    expect(PRE_TRADE_CHECKS.map((c) => c.check_code)).toEqual([
      'CAPITAL',
      'MAX_POSITIONS',
      'MAX_NOTIONAL_PER_LEG',
      'MAX_LEVERAGE',
      'MIN_FUNDING_SPREAD',
      'EXPECTED_NET_PNL',
      'MAX_SLIPPAGE',
      'ORDERBOOK_DEPTH',
      'EXCHANGE_CONNECTIVITY',
      'API_LATENCY',
      'FUNDING_TIME_ALIGNMENT',
      'EXISTING_EXPOSURE',
      'DATA_FRESHNESS',
      'CLOCK_RELIABILITY',
      'ENTRY_GATE',
    ]);
  });

  it('every check_code is unique', () => {
    const codes = ALL_CHECKS.map((c) => c.check_code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every Pre-Trade check is critical', () => {
    expect(PRE_TRADE_CHECKS.every((c) => c.critical)).toBe(true);
  });

  it('every Entry/Position check declares a failAction', () => {
    expect([...ENTRY_CHECKS, ...POSITION_CHECKS].every((c) => c.failAction !== undefined)).toBe(true);
  });

  it('findCheck looks up by code and throws on unknown', () => {
    expect(findCheck('CAPITAL').name).toBe('Capital');
    expect(() => findCheck('NOPE')).toThrow();
  });
});
