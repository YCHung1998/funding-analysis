/**
 * runtime/src/storage/ledger.tradeLegTransition.test.ts
 *
 * `paper-execution-engine` task 3.2 prep — new `Ledger` methods needed by
 * the two-leg coordinators (design.md Decision 6): `applyTradeTransition`
 * (optionally releasing capital in the same transaction),
 * `applyLegTransition`, `appendEvent`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestLedger, type TestLedgerHarness } from '../../test/fakes/testLedger';

const harnesses: TestLedgerHarness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

function setup() {
  const harness = makeTestLedger({ start: 0 });
  harnesses.push(harness);
  return harness;
}

describe('Ledger.applyTradeTransition', () => {
  it('commits the trade row and a TRADE_STATUS_CHANGED event', () => {
    const h = setup();
    const before = h.tradeRepo.getTrade('trade1')!;
    const after = { ...before, status: 'PRE_FLIGHT' as const, updated_at: 5 };
    h.ledger.applyTradeTransition(before, after, 'preflight');

    const stored = h.tradeRepo.getTrade('trade1')!;
    expect(stored.status).toBe('PRE_FLIGHT');
    const events = h.eventStore.replay({ trade_id: 'trade1' });
    const last = events[events.length - 1];
    expect(last.event_type).toBe('TRADE_STATUS_CHANGED');
    expect(last.payload).toMatchObject({ from: 'CREATED', to: 'PRE_FLIGHT', reason: 'preflight' });
  });

  it('releases capital in the same transaction when releaseCapitalReason is given', () => {
    const h = setup();
    // Distinct snapshot_time per step: `account_snapshots` orders latest by
    // (snapshot_time DESC, snapshot_id DESC) and snapshot_id is a random
    // UUID, which does not reliably tie-break against the harness's fixed
    // "init" id at snapshot_time=0 — advancing the clock disambiguates.
    h.clock.advanceTo(1);
    const before = h.tradeRepo.getTrade('trade1')!;
    const preFlight = { ...before, status: 'PRE_FLIGHT' as const, updated_at: 1 };
    h.ledger.applyTradeTransition(before, preFlight, 'preflight');
    h.clock.advanceTo(2);
    const entryPending = { ...preFlight, status: 'ENTRY_PENDING' as const, updated_at: 2 };
    h.ledger.applyTradeTransition(preFlight, entryPending, 'start entry');

    h.clock.advanceTo(3);
    const aborted = { ...entryPending, status: 'ABORTED' as const, updated_at: 3 };
    h.ledger.applyTradeTransition(entryPending, aborted, 'both legs zero filled', { releaseCapitalReason: 'ENTRY_TIMEOUT' });

    const snapshot = h.accountRepo.getLatestAccountSnapshot('PAPER')!;
    expect(snapshot.snapshot_time).toBe(3);
    expect(snapshot.reserved_capital_usdt).toBe(0);
    expect(snapshot.available_capital_usdt).toBe(100_000);

    const events = h.eventStore.replay({ trade_id: 'trade1' });
    const types = events.map((e) => e.event_type);
    expect(types[types.length - 2]).toBe('TRADE_STATUS_CHANGED');
    expect(types[types.length - 1]).toBe('CAPITAL_RELEASED');
  });

  it('throws IllegalTransitionError for a disallowed transition', () => {
    const h = setup();
    const before = h.tradeRepo.getTrade('trade1')!;
    const after = { ...before, status: 'CLOSED' as const };
    expect(() => h.ledger.applyTradeTransition(before, after, 'bad')).toThrow();
  });
});

describe('Ledger.applyLegTransition', () => {
  it('commits the leg row and a LEG_STATUS_CHANGED event', () => {
    const h = setup();
    const before = h.tradeRepo.getTrade('trade1')!.legs.find((l) => l.leg_id === 'legL')!;
    const after = { ...before, status: 'OPENING' as const, updated_at: 5 };
    h.ledger.applyLegTransition(before, after, 'submitted entry order');

    const stored = h.tradeRepo.getTrade('trade1')!.legs.find((l) => l.leg_id === 'legL')!;
    expect(stored.status).toBe('OPENING');
    const events = h.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.leg_id === 'legL');
    expect(events[events.length - 1].event_type).toBe('LEG_STATUS_CHANGED');
  });
});

describe('Ledger.appendEvent', () => {
  it('commits an arbitrary observational event (e.g. HEDGE_RATIO_CHANGED)', () => {
    const h = setup();
    h.ledger.appendEvent({
      event_id: 'e1',
      event_type: 'HEDGE_RATIO_CHANGED',
      timestamp: 10,
      trade_id: 'trade1',
      payload: { ratio: 1, basis: 'QUANTITY', notional_ratio: 1, quantity_ratio: 1, long_value: 10, short_value: 10 },
    });
    const events = h.eventStore.replay({ trade_id: 'trade1' });
    expect(events[events.length - 1].event_type).toBe('HEDGE_RATIO_CHANGED');
  });
});
