/**
 * runtime/test/scenarios/reconciliationEntryHalt.scenario.test.ts
 *
 * Task 4.3 — reconciliation error halts entry (design.md Decision 1/2, spec
 * §31 "should also trigger STOP ENTRY"). A `Reconciler.runOnce()` pass that
 * finds a mismatch (here: the account snapshot's `available_capital_usdt`
 * disagreeing with `total - reserved`, `CAPITAL_AVAILABLE`) must append
 * `RECONCILIATION_ERROR` and request an entry halt, WITHOUT cancelling any
 * order or closing any position (design.md Non-goals / C-16). Real
 * `Ledger`/`EventStore`/temp-dir SQLite/`VirtualClock`.
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { makeTestLedger } from '../fakes/testLedger';
import { EntryHaltLatch } from '../../src/reconciliation/entryHalt';
import { Reconciler } from '../../src/reconciliation/reconciler';
import { DEFAULT_RECONCILIATION_CONFIG } from '../../src/reconciliation/types';
import { migrate } from '../../src/storage/migrate';
import { migration003 } from '../../src/storage/migrations/003_runtime_health';
import type { AccountSnapshot } from '../../src/types';

describe('reconciliation error halts entry (tasks.md 4.3)', () => {
  it('a CAPITAL_AVAILABLE mismatch appends RECONCILIATION_ERROR and halts entry without touching orders/positions', () => {
    const harness = makeTestLedger({ start: 0 });
    // `makeTestLedger` only applies 001+002 (paper-execution-engine's fixture
    // predates this change) — the Reconciler needs 003's `reconciliation_runs` table too.
    migrate(harness.db, [migration003]);
    // `makeTestLedger` seeds legL/legS directly (no event) — open them via a
    // real `LEG_STATUS_CHANGED` so `assertTraceability` has something to check.
    const seedTrade = harness.tradeRepo.getTrade('trade1')!;
    for (const leg of seedTrade.legs) {
      harness.ledger.applyLegTransition(leg, { ...leg, status: 'OPENING', updated_at: harness.clock.now() }, 'entry started');
    }
    const entryHalt = new EntryHaltLatch(harness.eventStore, harness.clock);
    const reconciler = new Reconciler({
      db: harness.db,
      clock: harness.clock,
      repos: { trade: harness.tradeRepo, order: harness.orderRepo, account: harness.accountRepo },
      eventStore: harness.eventStore,
      ledger: harness.ledger,
      entryHalt,
      config: DEFAULT_RECONCILIATION_CONFIG,
    });

    expect(entryHalt.isHalted()).toBe(false);

    // Corrupt the account snapshot directly (bypassing the Ledger), simulating
    // a data inconsistency the reconciler must discover on its own.
    const latest = harness.accountRepo.getLatestAccountSnapshot('PAPER')!;
    const corrupted: AccountSnapshot = { ...latest, snapshot_id: 'corrupt1', available_capital_usdt: latest.available_capital_usdt - 500 };
    harness.accountRepo.saveAccountSnapshot(corrupted);

    const run = reconciler.runOnce();

    expect(run.mismatch_count).toBeGreaterThan(0);
    expect(entryHalt.isHalted()).toBe(true);
    expect(entryHalt.reasons()[0].source).toBe('RECONCILIATION');

    const events = harness.eventStore.replay();
    const mismatchEvents = events.filter((e) => e.event_type === 'RECONCILIATION_ERROR');
    expect(mismatchEvents.length).toBeGreaterThan(0);
    expect(mismatchEvents.some((e) => (e.payload as { check_id: string }).check_id === 'CAPITAL_AVAILABLE')).toBe(true);

    // Non-goal: no CANCEL / EXIT / POSITION_CLOSED event — no order cancelled, no position closed.
    expect(events.some((e) => e.event_type.startsWith('ORDER_CANCEL'))).toBe(false);
    expect(events.some((e) => e.event_type === 'POSITION_CLOSED')).toBe(false);

    // The pre-existing trade1 (CREATED, non-terminal, no mismatch of its own) is untouched.
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('CREATED');

    assertTraceability(harness.db);
  });
});
