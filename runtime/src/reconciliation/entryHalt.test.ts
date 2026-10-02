/**
 * runtime/src/reconciliation/entryHalt.test.ts
 *
 * Task 2.3 — `EntryHaltLatch` (design.md Decision 2 `EntryHaltPort` +
 * Implementation Notes "`EntryHaltPort` 的 `EntryHaltLatch` 持久化"):
 * `requestHalt` is a synchronous `ENTRY_HALT_REQUESTED` ledger event (no
 * `trade_id`), only `clearHalt` (operator action, writes `ENTRY_HALT_CLEARED`)
 * clears it, and the halted state SURVIVES A RESTART because it is rebuilt by
 * replaying the event store — never kept only in memory. Uses a real
 * `EventStore` + temp-dir SQLite DB + `VirtualClock`, never a real exchange
 * API or wall-clock sleep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import { NodeSqliteDriver } from '../storage/driver';
import { EventStore } from '../storage/eventStore';
import { migrate } from '../storage/migrate';
import { migration001 } from '../storage/migrations/001_initial';
import { migration002 } from '../storage/migrations/002_position_accounting_fields';
import { tmpDriver } from '../storage/test-helpers';
import { EntryHaltLatch } from './entryHalt';

describe('EntryHaltLatch (design.md Decision 2)', () => {
  let db: NodeSqliteDriver;
  let clock: VirtualClock;
  let eventStore: EventStore;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001, migration002]);
    clock = new VirtualClock(1000);
    eventStore = new EventStore(db, clock);
  });

  afterEach(() => {
    db.close();
  });

  it('starts not halted when the event store is empty', () => {
    const latch = new EntryHaltLatch(eventStore, clock);
    expect(latch.isHalted()).toBe(false);
    expect(latch.reasons()).toEqual([]);
  });

  it('requestHalt writes ENTRY_HALT_REQUESTED (trade_id null) and halts immediately', () => {
    const latch = new EntryHaltLatch(eventStore, clock);
    latch.requestHalt({ source: 'RECONCILIATION', reason: 'ORDER_FILL_SUM', trade_ids: ['t1'] });

    expect(latch.isHalted()).toBe(true);
    expect(latch.reasons()).toHaveLength(1);
    expect(latch.reasons()[0]).toMatchObject({ source: 'RECONCILIATION', reason: 'ORDER_FILL_SUM', trade_ids: ['t1'] });

    const events = eventStore.replay();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('ENTRY_HALT_REQUESTED');
    expect(events[0].trade_id).toBeNull();
  });

  it('accumulates multiple halt requests from different sources as separate reasons', () => {
    const latch = new EntryHaltLatch(eventStore, clock);
    latch.requestHalt({ source: 'RECONCILIATION', reason: 'ORDER_FILL_SUM', trade_ids: ['t1'] });
    latch.requestHalt({ source: 'DATABASE', reason: 'EVENT_QUEUE_OVERFLOW', trade_ids: [] });

    expect(latch.isHalted()).toBe(true);
    expect(latch.reasons()).toHaveLength(2);
  });

  it('only clearHalt (ENTRY_HALT_CLEARED) clears it — a second requestHalt call never clears a prior one', () => {
    const latch = new EntryHaltLatch(eventStore, clock);
    latch.requestHalt({ source: 'RECONCILIATION', reason: 'A', trade_ids: [] });
    latch.requestHalt({ source: 'RECONCILIATION', reason: 'B', trade_ids: [] });
    expect(latch.reasons()).toHaveLength(2);

    latch.clearHalt({ actor: 'ops', reason: 'manual review done' });
    expect(latch.isHalted()).toBe(false);
    expect(latch.reasons()).toEqual([]);

    const events = eventStore.replay();
    expect(events.filter((e) => e.event_type === 'ENTRY_HALT_CLEARED')).toHaveLength(1);
  });

  it('survives a restart: a fresh EntryHaltLatch instance rebuilds halted state by replaying the event store', () => {
    const latch1 = new EntryHaltLatch(eventStore, clock);
    latch1.requestHalt({ source: 'RECONCILIATION', reason: 'ORDER_FILL_SUM', trade_ids: ['t1'] });

    // Simulate a process restart: a brand-new EntryHaltLatch over the same EventStore/DB.
    const latch2 = new EntryHaltLatch(eventStore, clock);
    expect(latch2.isHalted()).toBe(true);
    expect(latch2.reasons()).toHaveLength(1);
    expect(latch2.reasons()[0]).toMatchObject({ source: 'RECONCILIATION', reason: 'ORDER_FILL_SUM' });
  });

  it('after a restart post-clear, a fresh instance correctly rebuilds as NOT halted', () => {
    const latch1 = new EntryHaltLatch(eventStore, clock);
    latch1.requestHalt({ source: 'RECONCILIATION', reason: 'X', trade_ids: [] });
    latch1.clearHalt({ actor: 'ops', reason: 'resolved' });

    const latch2 = new EntryHaltLatch(eventStore, clock);
    expect(latch2.isHalted()).toBe(false);
    expect(latch2.reasons()).toEqual([]);
  });

  it('only halt requests AFTER the last ENTRY_HALT_CLEARED count toward the rebuilt state', () => {
    const latch1 = new EntryHaltLatch(eventStore, clock);
    latch1.requestHalt({ source: 'RECONCILIATION', reason: 'OLD', trade_ids: [] });
    latch1.clearHalt({ actor: 'ops', reason: 'resolved' });
    latch1.requestHalt({ source: 'RECONCILIATION', reason: 'NEW', trade_ids: [] });

    const latch2 = new EntryHaltLatch(eventStore, clock);
    expect(latch2.isHalted()).toBe(true);
    expect(latch2.reasons()).toHaveLength(1);
    expect(latch2.reasons()[0]).toMatchObject({ reason: 'NEW' });
  });
});
