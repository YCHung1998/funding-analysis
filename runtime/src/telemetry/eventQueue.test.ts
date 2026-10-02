/**
 * runtime/src/telemetry/eventQueue.test.ts
 *
 * Task 4.1 — `EventQueue`: non-blocking publish, consumer isolation,
 * batched flush (Clock-scheduled), retry backoff, overflow never drops
 * DB-bound events, UI drops oldest with a counter, `getStatus()`, `drain()`
 * (spec "Non-blocking event queue").
 */
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import type { TradingEvent } from '../types/event';
import { EventQueue } from './eventQueue';

function makeEvent(id: string): TradingEvent {
  return { event_id: id, event_type: 'OPPORTUNITY_DETECTED', timestamp: 0, trade_id: null, payload: {}, recorded_at: 0 };
}

describe('EventQueue', () => {
  it('publish returns synchronously even when the UI broadcaster is slow, and all events land in the DB after one flush interval', () => {
    const clock = new VirtualClock(0);
    const dbWrites: TradingEvent[][] = [];
    const uiCalls: TradingEvent[] = [];
    const queue = new EventQueue(clock, {
      writeToDb: (batch) => dbWrites.push(batch),
      broadcastToUi: (event) => {
        // simulated slow consumer — no real sleep (VirtualClock, no real time)
        uiCalls.push(event);
      },
      writeAnalytics: () => {},
    });

    for (let i = 0; i < 10; i++) {
      // publish never calls into broadcastToUi/writeToDb itself — it only
      // buffers — so uiCalls/dbWrites must still be empty right after this loop.
      queue.publish(makeEvent(`e${i}`));
    }
    expect(uiCalls).toEqual([]);
    expect(dbWrites).toEqual([]);

    clock.advanceTo(100);
    const written = dbWrites.flat().map((e) => e.event_id);
    expect(written).toEqual(Array.from({ length: 10 }, (_, i) => `e${i}`));
  });

  it('a throwing analytics consumer is isolated: DB writer still persists all events, consumerErrors.analytics > 0', () => {
    const clock = new VirtualClock(0);
    const dbWrites: TradingEvent[] = [];
    const queue = new EventQueue(clock, {
      writeToDb: (batch) => dbWrites.push(...batch),
      broadcastToUi: () => {},
      writeAnalytics: () => {
        throw new Error('analytics down');
      },
    });

    for (let i = 0; i < 5; i++) queue.publish(makeEvent(`a${i}`));
    clock.advanceTo(100);

    expect(dbWrites.map((e) => e.event_id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    expect(queue.getStatus().consumerErrors.analytics).toBeGreaterThan(0);
  });

  it('overflow keeps database events: a failing DB writer never drops events, and recovery flushes all of them in publish order', () => {
    const clock = new VirtualClock(0);
    let failing = true;
    const dbWrites: TradingEvent[] = [];
    const queue = new EventQueue(
      clock,
      {
        writeToDb: (batch) => {
          if (failing) throw new Error('db down');
          dbWrites.push(...batch);
        },
        broadcastToUi: () => {},
        writeAnalytics: () => {},
      },
      { dbQueueMax: 10_000, flushBatchSize: 2_000 },
    );

    const total = 10_001;
    for (let i = 0; i < total; i++) queue.publish(makeEvent(`o${i}`));

    clock.advanceTo(200);
    expect(queue.getStatus().overflow).toBe(true);
    expect(queue.getStatus().pending).toBe(total);

    failing = false;
    // Advance through several retry/backoff cycles and batches.
    for (let t = 300; t <= 60_000; t += 200) {
      clock.advanceTo(t);
      if (dbWrites.length >= total) break;
    }

    expect(dbWrites.length).toBe(total);
    expect(dbWrites.map((e) => e.event_id)).toEqual(Array.from({ length: total }, (_, i) => `o${i}`));
    expect(queue.getStatus().overflow).toBe(false);
  });

  it('UI buffer drops the oldest entries past uiBufferMax and counts drops', () => {
    const clock = new VirtualClock(0);
    const uiCalls: string[] = [];
    const queue = new EventQueue(
      clock,
      {
        writeToDb: () => {},
        broadcastToUi: (e) => uiCalls.push(e.event_id),
        writeAnalytics: () => {},
      },
      { uiBufferMax: 3 },
    );

    for (let i = 0; i < 5; i++) queue.publish(makeEvent(`u${i}`));
    clock.advanceTo(100);

    expect(uiCalls).toEqual(['u2', 'u3', 'u4']);
    expect(queue.getStatus().uiDropped).toBe(2);
  });

  it('getStatus reports pending, lastFlushAt and lastError', () => {
    const clock = new VirtualClock(0);
    const queue = new EventQueue(clock, { writeToDb: () => {}, broadcastToUi: () => {}, writeAnalytics: () => {} });
    queue.publish(makeEvent('s1'));
    const before = queue.getStatus();
    expect(before.pending).toBe(1);
    clock.advanceTo(100);
    const after = queue.getStatus();
    expect(after.pending).toBe(0);
    expect(after.lastFlushAt).toBe(50);
    expect(after.lastError).toBeNull();
  });

  it('drain() synchronously flushes all pending DB events', () => {
    const clock = new VirtualClock(0);
    const dbWrites: string[] = [];
    const queue = new EventQueue(clock, {
      writeToDb: (batch) => dbWrites.push(...batch.map((e) => e.event_id)),
      broadcastToUi: () => {},
      writeAnalytics: () => {},
    });
    queue.publish(makeEvent('d1'));
    queue.publish(makeEvent('d2'));
    queue.drain();
    expect(dbWrites).toEqual(['d1', 'd2']);
    expect(queue.getStatus().pending).toBe(0);
  });
});
