import { describe, expect, it } from 'vitest';
import { DEFAULT_VENUE_RULES, pairGuard } from './venueRules';

describe('venue settlement rules (funding-settlement-rules spec)', () => {
  it('Binance is 15000/15000 ms, Bybit is 5000/5000 ms, OKX is 0/60000 ms', () => {
    expect(DEFAULT_VENUE_RULES.Binance).toMatchObject({ guardBeforeMs: 15_000, guardAfterMs: 15_000 });
    expect(DEFAULT_VENUE_RULES.Bybit).toMatchObject({ guardBeforeMs: 5_000, guardAfterMs: 5_000 });
    expect(DEFAULT_VENUE_RULES.OKX).toMatchObject({ guardBeforeMs: 0, guardAfterMs: 60_000 });
  });

  it('pair guard uses the wider venue (Binance x Bybit)', () => {
    const guard = pairGuard(DEFAULT_VENUE_RULES.Binance!, DEFAULT_VENUE_RULES.Bybit!);
    expect(guard).toEqual({ guardBeforeMs: 15_000, guardAfterMs: 15_000 });
  });

  it('pair guard propagates the wider window (OKX leg)', () => {
    const guard = pairGuard(DEFAULT_VENUE_RULES.OKX!, DEFAULT_VENUE_RULES.Binance!);
    expect(guard).toEqual({ guardBeforeMs: 15_000, guardAfterMs: 60_000 });
  });
});
