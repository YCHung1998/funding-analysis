/**
 * server/paperWsGateway.ts
 *
 * `paper-trading-event-stream` tasks 3.1/3.2 (design.md Decisions 2 & 4): the
 * WebSocket connection registry for `/ws/paper`. On connect, sends `{ type:
 * 'hello', last_seq }`; thereafter forwards every broadcast from the single
 * shared `server/paperEventTailer.ts` poller as `{ type: 'event' }` / `{
 * type: 'health' }` to every open connection ("one poller, reused by every
 * connected socket" — design.md Decision 1). Ignores all inbound
 * application-layer messages (A-10: "server 只轉發，不保證送達") — the
 * frontend hook (`src/features/paperTrading/hooks/usePaperEventStream.ts`)
 * never sends any, confirmed by reading that file in full; no `ws.send`
 * call exists there.
 *
 * Backpressure (design.md Decision 4): each connection gets a bounded
 * outbound queue (`queueLimit`, default 1000) counted by in-flight `send()`
 * calls whose flush callback hasn't fired yet (not bytes). A broadcast that
 * would push a connection over its limit closes that connection (WS close
 * code 1008 "Policy Violation") instead of blocking the broadcast loop for
 * other connections or dropping messages silently. Recovery is the client's
 * own already-merged, already-tested reconnect + A-9 backfill path — this
 * gateway does not buffer a replay log per connection (design.md Decision 4
 * "Alternative considered").
 *
 * No exchange-name literal appears in this file (hard project convention).
 */
import type { TradingEvent } from '../runtime/src/types';
import type { HealthApiPayload } from '../runtime/src/health/healthPublisher';

/**
 * The minimal socket surface this gateway needs — satisfied by a real `ws`
 * `WebSocket` and trivially faked in tests (no real network/timers
 * required; `paperWsGateway.test.ts` exercises backpressure purely by
 * controlling when the fake socket's `send` callback fires).
 */
export interface GatewaySocket {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message' | 'close', listener: (...args: unknown[]) => void): void;
}

export interface PaperWsGatewayOptions {
  /** Default 1000 (design.md Decision 4). */
  queueLimit?: number;
}

type PaperWsBroadcast =
  | { type: 'event'; seq: number; event: TradingEvent }
  | { type: 'health'; health: HealthApiPayload };

type PaperWsHello = { type: 'hello'; last_seq: number };

interface ConnectionState {
  socket: GatewaySocket;
  /** Count of `send()` calls issued whose flush callback hasn't fired yet. */
  pending: number;
}

const DEFAULT_QUEUE_LIMIT = 1000;
/** WS close code 1008 "Policy Violation" — the closest standard code for "you were too slow". */
const QUEUE_OVERFLOW_CLOSE_CODE = 1008;
const QUEUE_OVERFLOW_CLOSE_REASON = 'event_stream_queue_overflow';

export class PaperWsGateway {
  private readonly connections = new Set<ConnectionState>();
  private readonly queueLimit: number;

  constructor(options: PaperWsGatewayOptions = {}) {
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Registers a newly-opened socket, sends its `hello` frame, and starts forwarding broadcasts to it. */
  handleConnection(socket: GatewaySocket, helloLastSeq: number): void {
    const state: ConnectionState = { socket, pending: 0 };
    this.connections.add(state);
    // Inbound application messages are intentionally ignored — the channel is send-only (A-10).
    socket.on('message', () => {});
    socket.on('close', () => {
      this.connections.delete(state);
    });
    this.deliver(state, { type: 'hello', last_seq: helloLastSeq });
  }

  /** Forwards a new `trading_events` row to every open connection (`paperEventTailer`'s `onEvents` callback). */
  broadcastEvent(seq: number, event: TradingEvent): void {
    this.broadcast({ type: 'event', seq, event });
  }

  /** Forwards a `runtime_health` change to every open connection (`paperEventTailer`'s `onHealth` callback). */
  broadcastHealth(health: HealthApiPayload): void {
    this.broadcast({ type: 'health', health });
  }

  private broadcast(message: PaperWsBroadcast): void {
    // Snapshot first: `deliver` may synchronously remove a connection from `this.connections`
    // (on overflow) or a slow socket's own `close` callback may fire re-entrantly; iterating a
    // live Set while mutating it is unsafe, a copy isn't.
    for (const state of [...this.connections]) {
      this.deliver(state, message);
    }
  }

  private deliver(state: ConnectionState, message: PaperWsBroadcast | PaperWsHello): void {
    if (!this.connections.has(state)) return; // already closed (e.g. by a prior overflow this same tick)
    if (state.pending >= this.queueLimit) {
      this.connections.delete(state);
      state.socket.close(QUEUE_OVERFLOW_CLOSE_CODE, QUEUE_OVERFLOW_CLOSE_REASON);
      return;
    }
    state.pending += 1;
    state.socket.send(JSON.stringify(message), () => {
      state.pending -= 1;
    });
  }
}
