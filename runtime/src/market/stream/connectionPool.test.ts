import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../clock/virtualClock';
import type { TradingEvent } from '../../types/event';
import type { EventSink } from '../instruments/types';
import { createFakeWebSocketFactory } from '../testDoubles/fakeWebSocket';
import { ConnectionPool } from './connectionPool';

function makePool(overrides?: { max_topics_per_connection?: number; max_connection_lifetime_ms?: number; rotation_lead_ms?: number }) {
  const clock = new VirtualClock(0);
  const sink: EventSink = { emit: () => {} };
  const { factory, sockets } = createFakeWebSocketFactory();
  const pool = new ConnectionPool({
    clock,
    eventSink: sink,
    exchange: 'Binance',
    wsFactory: factory,
    url: 'wss://x',
    heartbeat: { idle_timeout_ms: 999_999_999 },
    parse: (raw) => (raw.includes('ack') ? [{ kind: 'ACK', topics: [] }] : []),
    buildSubscribe: (topics) => JSON.stringify({ sub: topics }),
    buildUnsubscribe: (topics) => JSON.stringify({ unsub: topics }),
    onMessage: () => {},
    backoff: { base_ms: 1000, max_ms: 60000, jitter_ratio: 0 },
    backoff_reset_after_ms: 60000,
    max_topics_per_connection: overrides?.max_topics_per_connection,
    max_connection_lifetime_ms: overrides?.max_connection_lifetime_ms,
    rotation_lead_ms: overrides?.rotation_lead_ms,
  });
  return { clock, sockets, pool };
}

describe('ConnectionPool', () => {
  it('shards 450 topics across 3 connections with a 200-topic cap', () => {
    const { sockets, pool } = makePool({ max_topics_per_connection: 200 });
    const topics = Array.from({ length: 450 }, (_, i) => `t${i}`);
    pool.subscribe(topics);
    expect(sockets).toHaveLength(3);
    const counts = pool.connections().map((c) => c.currentTopics().length);
    expect(counts.sort((a, b) => b - a)).toEqual([200, 200, 50]);
  });

  it('builds the replacement connection before tearing down the old one on rotation', () => {
    const { clock, sockets, pool } = makePool({ max_connection_lifetime_ms: 24 * 3_600_000, rotation_lead_ms: 5 * 60_000 });
    pool.subscribe(['BTCUSDT@bookTicker']);
    sockets[0].simulateOpen();
    sockets[0].simulateMessage('ack');

    clock.advanceTo(23 * 3_600_000 + 55 * 60_000); // 23h55m: rotation fires
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets[0].readyState).not.toBe(3); // 舊連線尚未關閉（新連線尚未 OPEN）

    sockets[1].simulateOpen();
    sockets[1].simulateMessage('ack');
    clock.advanceTo(23 * 3_600_000 + 55 * 60_000 + 200);
    expect(sockets[0].readyState).toBe(3); // 新連線 OPEN 後舊連線才關閉
  });
});
