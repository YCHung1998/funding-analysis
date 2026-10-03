/**
 * server/paperWsGateway.test.ts — `paper-trading-event-stream` tasks 3.1/3.2.
 *
 * Covers `PaperWsGateway` against a fake `GatewaySocket` (no real network,
 * no real timers): hello-on-connect, event/health broadcast to every open
 * connection, inbound messages ignored, and backpressure (bounded
 * per-connection queue, close-on-overflow, other connections unaffected,
 * reconnect-and-backfill-via-A-9 end-to-end).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PaperWsGateway, type GatewaySocket } from './paperWsGateway';
import { createPaperDbFixture, type PaperDbFixture } from './test/paperDbFixture';
import { getEventsAfter, openPaperDb } from './paperReadLayer';
import { EventStore } from '../runtime/src/storage/eventStore';
import type { Opportunity, Trade } from '../runtime/src/types';

/** A fake socket: `flushMode: 'sync'` calls the send callback immediately (message "delivered"); `'never'` never calls it back (simulates a stalled/slow consumer, the only way to deterministically exercise backpressure without real timers or network). */
class FakeSocket implements GatewaySocket {
  readonly sent: unknown[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private messageListener: ((data: unknown) => void) | undefined;
  private closeListener: (() => void) | undefined;

  constructor(private readonly flushMode: 'sync' | 'never' = 'sync') {}

  send(data: string, cb?: (err?: Error) => void): void {
    if (this.closed) return;
    this.sent.push(JSON.parse(data));
    if (this.flushMode === 'sync') cb?.();
    // 'never': callback intentionally never invoked -- pending count never decrements.
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.closeListener?.();
  }

  on(event: 'message' | 'close', listener: (...args: unknown[]) => void): void {
    if (event === 'message') this.messageListener = listener as (data: unknown) => void;
    if (event === 'close') this.closeListener = listener as () => void;
  }

  /** Test helper: simulate the client sending an inbound application message. */
  simulateInboundMessage(data: unknown): void {
    this.messageListener?.(data);
  }
}

describe('PaperWsGateway — task 3.1', () => {
  it('sends hello with the given last_seq on connect', () => {
    const gateway = new PaperWsGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, 42);
    expect(socket.sent).toEqual([{ type: 'hello', last_seq: 42 }]);
  });

  it('forwards a new event to every connected socket', () => {
    const gateway = new PaperWsGateway();
    const a = new FakeSocket();
    const b = new FakeSocket();
    gateway.handleConnection(a, 0);
    gateway.handleConnection(b, 0);

    const event = { event_id: 'e1', event_type: 'TRADE_CREATED', timestamp: 1, trade_id: 't1', payload: {}, recorded_at: 1 } as const;
    gateway.broadcastEvent(43, event as never);

    expect(a.sent[1]).toEqual({ type: 'event', seq: 43, event });
    expect(b.sent[1]).toEqual({ type: 'event', seq: 43, event });
  });

  it('forwards a health change to every connected socket', () => {
    const gateway = new PaperWsGateway();
    const a = new FakeSocket();
    gateway.handleConnection(a, 0);

    const health = { engine: 'RUNNING' } as never;
    gateway.broadcastHealth(health);

    expect(a.sent[1]).toEqual({ type: 'health', health });
  });

  it('ignores any inbound application message from the client', () => {
    const gateway = new PaperWsGateway();
    const a = new FakeSocket();
    gateway.handleConnection(a, 0);
    const sentBefore = a.sent.length;

    expect(() => a.simulateInboundMessage(JSON.stringify({ type: 'control', command: 'STOP' }))).not.toThrow();
    expect(a.sent.length).toBe(sentBefore); // no response sent
    expect(a.closed).toBeUndefined(); // no state change / disconnect
  });

  it('removes a connection from the registry once it closes', () => {
    const gateway = new PaperWsGateway();
    const a = new FakeSocket();
    gateway.handleConnection(a, 0);
    expect(gateway.connectionCount).toBe(1);

    a.close(1000, 'client went away');
    expect(gateway.connectionCount).toBe(0);

    // Further broadcasts must not throw even though the socket is gone.
    expect(() => gateway.broadcastEvent(1, {} as never)).not.toThrow();
  });
});

describe('PaperWsGateway — task 3.2 backpressure', () => {
  it('closes a slow-consumer connection once its queue reaches the limit, leaving other connections unaffected', () => {
    const gateway = new PaperWsGateway({ queueLimit: 3 });
    const slow = new FakeSocket('never'); // never flushes -- pending count only grows
    const fast = new FakeSocket('sync');
    gateway.handleConnection(slow, 0); // pending=1 (hello)
    gateway.handleConnection(fast, 0);

    for (let i = 1; i <= 3; i += 1) {
      gateway.broadcastEvent(i, { event_id: `e${i}` } as never);
    }
    // slow: hello(1) + e1(2) + e2(3) = pending at limit; e3 broadcast attempt finds pending>=3 -> close.
    expect(slow.closed).toEqual({ code: 1008, reason: 'event_stream_queue_overflow' });
    expect(gateway.connectionCount).toBe(1); // only `fast` remains

    // `fast` (flushes synchronously, pending never piles up) received every broadcast.
    expect(fast.sent).toEqual([
      { type: 'hello', last_seq: 0 },
      { type: 'event', seq: 1, event: { event_id: 'e1' } },
      { type: 'event', seq: 2, event: { event_id: 'e2' } },
      { type: 'event', seq: 3, event: { event_id: 'e3' } },
    ]);
  });

  it('end-to-end: after a forced disconnect, GET-/api/paper/events-equivalent backfill covers every missed event', () => {
    let fixture: PaperDbFixture | undefined;
    try {
      fixture = createPaperDbFixture();
      fixture.tradeRepo.saveOpportunity({
        opportunity_id: 'opp-t1',
        symbol: 'BTCUSDT',
        created_at: 0,
        detected_at: 0,
        expires_at: 1_000_000,
        updated_at: 0,
        long_exchange: 'Binance',
        short_exchange: 'Bybit',
        long_funding_rate: 0.0001,
        short_funding_rate: 0.0002,
        funding_spread: 0.0001,
        long_funding_time: 1,
        short_funding_time: 1,
        long_funding_interval_hours: 8,
        short_funding_interval_hours: 8,
        funding_time_diff_ms: 0,
        funding_aligned: true,
        long_price: 100,
        short_price: 100.1,
        price_difference_pct: 0.001,
        estimated_fee_pct: 0.0005,
        estimated_slippage_pct: 0.0005,
        estimated_funding_pnl: 1,
        estimated_net_pnl: 0.5,
        liquidity_score: 0.9,
        strategy_version: 'v1',
        status: 'SELECTED',
      } satisfies Opportunity);
      fixture.tradeRepo.saveTrade({
        trade_id: 't1',
        opportunity_id: 'opp-t1',
        strategy_id: 's1',
        strategy_version: 'v1',
        config_version: 'c1',
        symbol: 'BTCUSDT',
        mode: 'PAPER',
        created_at: 1000,
        updated_at: 1000,
        status: 'HEDGED',
        target_notional_per_leg_usdt: 1000,
        leverage: 1,
        allocated_margin_usdt: 500,
        allocated_capital_usdt: 1000,
        legs: [],
        expected_pnl_usdt: 1,
        risk_status: {
          overall_status: 'PASS',
          checks: [],
          failed_reasons: [],
          leg_imbalance_detected: false,
          action_recommendation: 'PROCEED_TRADE',
        },
      } satisfies Trade);

      const store = new EventStore(fixture.driver, { now: () => 0 });
      const gateway = new PaperWsGateway({ queueLimit: 2 });
      const client = new FakeSocket('never');
      gateway.handleConnection(client, 0); // pending=1 (hello)

      // Append + broadcast events one at a time, as the real tailer would.
      let clientLastKnownSeq = 0;
      for (let i = 1; i <= 5; i += 1) {
        const stored = store.append({ event_id: `e${i}`, event_type: 'TRADE_STATUS_CHANGED', timestamp: i, trade_id: 't1', payload: {} });
        // Record what the client actually saw (its `sent` array) before the broadcast that might close it.
        const wasOpen = !client.closed;
        gateway.broadcastEvent(stored.seq, stored);
        if (wasOpen && !client.closed) {
          clientLastKnownSeq = stored.seq; // client "saw" this one (pushed into its sent[] / lastSeqRef in the real hook)
        }
      }

      expect(client.closed).toBeDefined(); // forced-disconnect happened (queueLimit=2, 5 events)
      expect(clientLastKnownSeq).toBeGreaterThan(0);
      expect(clientLastKnownSeq).toBeLessThan(5); // genuinely disconnected before seeing everything

      // "Reconnect": the real client calls GET /api/paper/events?after_seq=<lastSeqRef>.
      const reader = openPaperDb(fixture.path)!;
      try {
        const backfill = getEventsAfter(reader, clientLastKnownSeq, 500);
        const backfilledSeqs = backfill.items.map((e) => e.seq);
        const missedSeqs = [1, 2, 3, 4, 5].filter((s) => s > clientLastKnownSeq);
        expect(backfilledSeqs).toEqual(missedSeqs); // every event missed during the gap, none skipped
      } finally {
        reader.close();
      }
    } finally {
      fixture?.close();
    }
  });
});
