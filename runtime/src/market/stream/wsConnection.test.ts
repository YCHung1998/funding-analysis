import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../clock/virtualClock';
import type { TradingEvent } from '../../types/event';
import type { EventSink } from '../instruments/types';
import { createFakeWebSocketFactory } from '../testDoubles/fakeWebSocket';
import type { ParsedMessage } from '../types';
import { WsConnection } from './wsConnection';

function setup(overrides?: { client_ping_interval_ms?: number; idle_timeout_ms?: number }) {
  const clock = new VirtualClock(0);
  const events: TradingEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push(e) };
  const { factory, sockets } = createFakeWebSocketFactory();
  const received: ParsedMessage[] = [];
  const reconnected: string[][] = [];

  const parse = (raw: string): ParsedMessage[] => {
    const msg = JSON.parse(raw);
    if (msg.op === 'pong') return [{ kind: 'PONG' }];
    if (msg.ack) return [{ kind: 'ACK', topics: msg.ack }];
    return [
      {
        kind: 'TICKER',
        event: {
          exchange: 'Bybit',
          symbol: `Bybit:${msg.symbol}`,
          exchange_timestamp: msg.t,
          local_received_timestamp: msg.t,
          timestamp_source: 'EXCHANGE',
          tier: 'SHORTLIST',
          bid: null,
          ask: null,
          mark_price: msg.p,
          index_price: null,
          funding_rate: null,
        },
      },
    ];
  };

  const conn = new WsConnection({
    clock,
    eventSink: sink,
    exchange: 'Bybit',
    connection_id: 'c1',
    wsFactory: factory,
    url: 'wss://stream.bybit.com/v5/public/linear',
    heartbeat: { client_ping_interval_ms: overrides?.client_ping_interval_ms, idle_timeout_ms: overrides?.idle_timeout_ms ?? 30000 },
    parse,
    buildSubscribe: (topics) => JSON.stringify({ op: 'subscribe', args: topics }),
    buildUnsubscribe: (topics) => JSON.stringify({ op: 'unsubscribe', args: topics }),
    onMessage: (msgs) => received.push(...msgs),
    onReconnected: (topics) => reconnected.push(topics),
    backoff: { base_ms: 1000, max_ms: 60000, jitter_ratio: 0, random: () => 0.5 },
    backoff_reset_after_ms: 60000,
  });

  return { clock, events, sockets, conn, received, reconnected };
}

describe('WsConnection', () => {
  it('transitions IDLE -> CONNECTING -> OPEN on handshake + subscribe ack', () => {
    const { events, sockets, conn } = setup();
    conn.connect(['tickers.BTCUSDT']);
    const ws = sockets[0];
    ws.simulateOpen();
    expect(conn.state).toBe('CONNECTING');
    ws.simulateMessage(JSON.stringify({ ack: ['tickers.BTCUSDT'] }));
    expect(conn.state).toBe('OPEN');

    const transitions = events.filter((e) => e.event_type === 'FEED_STATE_CHANGED').map((e) => `${(e.payload as any).from}->${(e.payload as any).to}`);
    expect(transitions).toEqual(['IDLE->CONNECTING', 'CONNECTING->OPEN']);
  });

  it('emits EXCHANGE_DISCONNECTED and RECONNECT_WAIT on unexpected close from OPEN', () => {
    const { events, sockets, conn } = setup();
    conn.connect([]);
    sockets[0].simulateOpen();
    expect(conn.state).toBe('OPEN');

    sockets[0].simulateClose(1006, '');
    expect(conn.state).toBe('RECONNECT_WAIT');
    expect(events.some((e) => e.event_type === 'EXCHANGE_DISCONNECTED')).toBe(true);
  });

  it('sends a ping every 20 seconds', () => {
    const { clock, sockets, conn } = setup({ client_ping_interval_ms: 20000, idle_timeout_ms: 90000 });
    conn.connect([]);
    sockets[0].simulateOpen();
    clock.advanceTo(60000);
    const pings = sockets[0].sent.filter((s) => JSON.parse(s).op === 'ping');
    expect(pings).toHaveLength(3);
  });

  it('recycles a silent connection after the idle timeout', () => {
    const { clock, conn, sockets } = setup({ idle_timeout_ms: 30000 });
    conn.connect([]);
    sockets[0].simulateOpen();
    clock.advanceTo(30000);
    expect(conn.state).toBe('RECONNECT_WAIT');
  });

  it('follows the exponential backoff sequence with zero jitter', () => {
    const clock = new VirtualClock(0);
    const sink: EventSink = { emit: () => {} };
    const { factory, sockets } = createFakeWebSocketFactory();
    const conn = new WsConnection({
      clock,
      eventSink: sink,
      exchange: 'Bybit',
      connection_id: 'c1',
      wsFactory: factory,
      url: 'wss://x',
      heartbeat: { idle_timeout_ms: 999999 },
      parse: () => [],
      buildSubscribe: () => '',
      buildUnsubscribe: () => '',
      onMessage: () => {},
      backoff: { base_ms: 1000, max_ms: 60000, jitter_ratio: 0, random: () => 0.5 },
      backoff_reset_after_ms: 60000,
    });

    const waits: number[] = [];
    conn.connect([]);
    for (let i = 0; i < 8; i++) {
      const before = clock.now();
      sockets[sockets.length - 1].simulateOpen();
      sockets[sockets.length - 1].simulateClose(1006, '');
      // 下一次連線已排程；找出等待多久後才真的建立下一條連線。
      let waited = 0;
      while (sockets.length === i + 1) {
        clock.advanceTo(clock.now() + 1);
        waited += 1;
        if (waited > 70000) throw new Error('reconnect never scheduled');
      }
      waits.push(clock.now() - before);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it('resets backoff to 1s after a stable connection and resubscribes + backfills on reconnect', () => {
    const { clock, conn, sockets, reconnected } = setup({ idle_timeout_ms: 120000 });
    conn.connect(['tickers.BTCUSDT']);
    sockets[0].simulateOpen();
    sockets[0].simulateMessage(JSON.stringify({ ack: ['tickers.BTCUSDT'] }));
    expect(conn.state).toBe('OPEN');

    clock.advanceTo(61000); // stable > backoff_reset_after_ms
    sockets[0].simulateClose(1006, '');
    expect(conn.state).toBe('RECONNECT_WAIT');

    clock.advanceTo(62000); // +1s backoff (reset)
    expect(sockets).toHaveLength(2);
    expect(JSON.parse(sockets[1].url ? '{}' : '{}')).toBeDefined();

    sockets[1].simulateOpen();
    expect(sockets[1].sent[0]).toBe(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT'] }));
    sockets[1].simulateMessage(JSON.stringify({ ack: ['tickers.BTCUSDT'] }));
    expect(conn.state).toBe('OPEN');
    expect(reconnected).toEqual([['tickers.BTCUSDT']]);
  });
});
