/**
 * runtime/src/storage/eventStore.test.ts
 *
 * Task 3.1 — `EventStore.append`: validator + `assertNoCredentials`, `seq`,
 * `recorded_at` from Clock, UPDATE/DELETE rejected by trigger (spec
 * "Append-only event store").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialLeakError } from '../types/validate';
import { VirtualClock } from '../clock/virtualClock';
import { NodeSqliteDriver } from './driver';
import { EventStore, EventValidationError } from './eventStore';
import { migrate } from './migrate';
import { migration001 } from './migrations/001_initial';
import { tmpDriver } from './test-helpers';

describe('EventStore.append', () => {
  let db: NodeSqliteDriver;
  let clock: VirtualClock;
  let store: EventStore;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001]);
    clock = new VirtualClock(1_700_000_000_100);
    store = new EventStore(db, clock, ['s3cr3t-value']);
  });

  afterEach(() => {
    db.close();
  });

  it('recorded_at differs from timestamp: set from the Clock at write time, not copied', () => {
    clock.advanceTo(1_700_000_000_140);
    const stored = store.append({
      event_id: 'evt1',
      event_type: 'OPPORTUNITY_DETECTED',
      timestamp: 1_700_000_000_100,
      trade_id: null,
      payload: {},
    });
    expect(stored.timestamp).toBe(1_700_000_000_100);
    expect(stored.recorded_at).toBe(1_700_000_000_140);
  });

  it('update is blocked by the append-only trigger', () => {
    store.append({ event_id: 'evt1', event_type: 'OPPORTUNITY_DETECTED', timestamp: 1, trade_id: null, payload: {} });
    expect(() => db.exec(`UPDATE trading_events SET event_type = 'X' WHERE event_id = 'evt1'`)).toThrow(/append-only/);
  });

  it('a payload containing api_secret throws CredentialLeakError and does not write the row', () => {
    expect(() =>
      store.append({
        event_id: 'evt1',
        event_type: 'OPPORTUNITY_DETECTED',
        timestamp: 1,
        trade_id: null,
        payload: { api_secret: 'xyz' },
      }),
    ).toThrow(CredentialLeakError);
    const count = db.prepare('SELECT COUNT(*) AS n FROM trading_events').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('a payload containing a known secret value throws CredentialLeakError', () => {
    expect(() =>
      store.append({
        event_id: 'evt1',
        event_type: 'OPPORTUNITY_DETECTED',
        timestamp: 1,
        trade_id: null,
        payload: { note: 'leaked s3cr3t-value here' },
      }),
    ).toThrow(CredentialLeakError);
  });

  it('three appended events get strictly increasing seq values', () => {
    const e1 = store.append({ event_id: 'e1', event_type: 'OPPORTUNITY_DETECTED', timestamp: 1, trade_id: null, payload: {} });
    const e2 = store.append({ event_id: 'e2', event_type: 'OPPORTUNITY_QUALIFIED', timestamp: 2, trade_id: null, payload: {} });
    const e3 = store.append({ event_id: 'e3', event_type: 'OPPORTUNITY_SELECTED', timestamp: 3, trade_id: null, payload: {} });
    expect(e1.seq).toBeLessThan(e2.seq);
    expect(e2.seq).toBeLessThan(e3.seq);
  });

  it('an invalid event_type fails validation and is not written', () => {
    expect(() =>
      store.append({
        // @ts-expect-error deliberately invalid for the test
        event_type: 'NOT_A_REAL_EVENT_TYPE',
        event_id: 'bad1',
        timestamp: 1,
        trade_id: null,
        payload: {},
      }),
    ).toThrow(EventValidationError);
    const count = db.prepare('SELECT COUNT(*) AS n FROM trading_events').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('a trade-scoped event type with trade_id null fails validation', () => {
    expect(() =>
      store.append({
        event_id: 'bad2',
        event_type: 'TRADE_CREATED',
        timestamp: 1,
        trade_id: null,
        payload: {},
      }),
    ).toThrow(EventValidationError);
  });
});
