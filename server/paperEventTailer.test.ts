/**
 * server/paperEventTailer.test.ts — task 1.2.
 *
 * Covers `PaperEventTailer`: polls `trading_events` (`seq > last_broadcast_seq`)
 * and `runtime_health` (`updated_at` change), each independently fault-tolerant
 * (design.md Decision 1 / Risks). No real timers — `pollOnce()` is called
 * directly; no real exchange API involved — every DB is a temp-dir SQLite
 * fixture seeded through the real `EventStore` / `HealthPublisher`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '../runtime/src/storage/driver';
import { migrate } from '../runtime/src/storage/migrate';
import { migration001 } from '../runtime/src/storage/migrations/001_initial';
import { migration003 } from '../runtime/src/storage/migrations/003_runtime_health';
import { EventStore } from '../runtime/src/storage/eventStore';
import { HealthPublisher, type HealthApiPayload } from '../runtime/src/health/healthPublisher';
import type { RuntimeHealthModel } from '../runtime/src/health/healthModel';
import { openPaperDb } from './paperReadLayer';
import { PaperEventTailer, getCurrentMaxSeq } from './paperEventTailer';

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'paper-event-tailer-test-'));
  return join(dir, 'paper.sqlite');
}

const HEALTH_MODEL: RuntimeHealthModel = {
  engine: 'RUNNING',
  exchanges: [],
  marketData: 'HEALTHY',
  scanner: 'RUNNING',
  risk: 'ARMED',
  paperExecution: 'ARMED',
  database: 'HEALTHY',
  clock: 'RELIABLE',
  credentials: 'PRESENT',
  entry_allowed: true,
  entry_block_reasons: [],
  last_event_at: null,
};

describe('PaperEventTailer — task 1.2', () => {
  let writer: NodeSqliteDriver | undefined;

  afterEach(() => {
    writer?.close();
    writer = undefined;
  });

  it('broadcasts events with seq > last_broadcast_seq and advances the watermark', () => {
    const path = tmpDbPath();
    writer = new NodeSqliteDriver(path);
    migrate(writer, [migration001, migration003]);
    const store = new EventStore(writer, { now: () => 1000 });
    store.append({ event_id: 'e1', event_type: 'TRADE_CREATED', timestamp: 1, trade_id: 't1', payload: {} });
    store.append({ event_id: 'e2', event_type: 'TRADE_CREATED', timestamp: 2, trade_id: 't1', payload: {} });

    const received: Array<{ seq: number; event_id: string }> = [];
    const tailer = new PaperEventTailer({
      openReader: () => openPaperDb(path),
      onEvents: (events) => received.push(...events.map((e) => ({ seq: e.seq, event_id: e.event_id }))),
      onHealth: () => {
        throw new Error('should not be called — no runtime_health row written yet');
      },
      now: () => 2000,
      healthStaleThresholdMs: 6000,
    });

    tailer.pollOnce();
    expect(received).toEqual([
      { seq: 1, event_id: 'e1' },
      { seq: 2, event_id: 'e2' },
    ]);
    expect(tailer.lastBroadcastSeq).toBe(2);

    // Second poll with no new rows: onEvents must not fire again.
    received.length = 0;
    tailer.pollOnce();
    expect(received).toEqual([]);

    // A third event appears -- only the new one is broadcast.
    store.append({ event_id: 'e3', event_type: 'TRADE_CREATED', timestamp: 3, trade_id: 't1', payload: {} });
    tailer.pollOnce();
    expect(received).toEqual([{ seq: 3, event_id: 'e3' }]);
    expect(tailer.lastBroadcastSeq).toBe(3);
  });

  it('broadcasts a health change exactly once per updated_at change', () => {
    const path = tmpDbPath();
    writer = new NodeSqliteDriver(path);
    migrate(writer, [migration001, migration003]);
    const publisher = new HealthPublisher({ db: writer, clock: { now: () => 500 } });
    publisher.publish(HEALTH_MODEL);

    const healthCalls: HealthApiPayload[] = [];
    const tailer = new PaperEventTailer({
      openReader: () => openPaperDb(path),
      onEvents: () => {},
      onHealth: (health) => healthCalls.push(health),
      now: () => 1000,
      healthStaleThresholdMs: 6000,
    });

    tailer.pollOnce();
    expect(healthCalls).toHaveLength(1);
    expect(healthCalls[0]!.engine).toBe('RUNNING');
    expect(healthCalls[0]!.runtime_heartbeat_at).toBe(500);

    // Unchanged updated_at -- no repeat broadcast.
    tailer.pollOnce();
    expect(healthCalls).toHaveLength(1);

    // Republish with a new updated_at -- broadcasts again.
    const publisher2 = new HealthPublisher({ db: writer, clock: { now: () => 1500 } });
    publisher2.publish(HEALTH_MODEL);
    tailer.pollOnce();
    expect(healthCalls).toHaveLength(2);
    expect(healthCalls[1]!.runtime_heartbeat_at).toBe(1500);
  });

  it('event path is unaffected when the runtime_health table does not exist', () => {
    const path = tmpDbPath();
    writer = new NodeSqliteDriver(path);
    migrate(writer, [migration001]); // no migration003 -- runtime_health table absent
    const store = new EventStore(writer, { now: () => 1000 });
    store.append({ event_id: 'e1', event_type: 'TRADE_CREATED', timestamp: 1, trade_id: 't1', payload: {} });

    const received: string[] = [];
    let healthCalled = false;
    const errors: Array<{ scope: string }> = [];
    const tailer = new PaperEventTailer({
      openReader: () => openPaperDb(path),
      onEvents: (events) => received.push(...events.map((e) => e.event_id)),
      onHealth: () => {
        healthCalled = true;
      },
      now: () => 2000,
      healthStaleThresholdMs: 6000,
      onError: (_err, scope) => errors.push({ scope }),
    });

    expect(() => tailer.pollOnce()).not.toThrow();
    expect(received).toEqual(['e1']);
    expect(healthCalled).toBe(false);
    expect(errors).toEqual([{ scope: 'health' }]);
  });

  it('pollOnce is a no-op (no throw) when the DB file does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paper-event-tailer-missing-'));
    const missingPath = join(dir, 'does-not-exist.sqlite');
    const tailer = new PaperEventTailer({
      openReader: () => openPaperDb(missingPath),
      onEvents: () => {
        throw new Error('should not be called');
      },
      onHealth: () => {
        throw new Error('should not be called');
      },
      now: () => 0,
      healthStaleThresholdMs: 6000,
    });
    expect(() => tailer.pollOnce()).not.toThrow();
  });
});

describe('getCurrentMaxSeq — task 3.1 support', () => {
  it('returns 0 for an empty trading_events table', () => {
    const path = tmpDbPath();
    const writer = new NodeSqliteDriver(path);
    migrate(writer, [migration001]);
    writer.close();
    const reader = openPaperDb(path)!;
    try {
      expect(getCurrentMaxSeq(reader)).toBe(0);
    } finally {
      reader.close();
    }
  });

  it('returns the current maximum seq', () => {
    const path = tmpDbPath();
    const writer = new NodeSqliteDriver(path);
    migrate(writer, [migration001]);
    const store = new EventStore(writer, { now: () => 1 });
    store.append({ event_id: 'e1', event_type: 'TRADE_CREATED', timestamp: 1, trade_id: 't1', payload: {} });
    store.append({ event_id: 'e2', event_type: 'TRADE_CREATED', timestamp: 2, trade_id: 't1', payload: {} });
    writer.close();

    const reader = openPaperDb(path)!;
    try {
      expect(getCurrentMaxSeq(reader)).toBe(2);
    } finally {
      reader.close();
    }
  });
});
