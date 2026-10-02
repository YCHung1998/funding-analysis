/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 單條 WebSocket 連線狀態機（market-data-stream spec「WebSocket connection
 * lifecycle」「Heartbeat and idle detection」「Reconnect with exponential backoff
 * and recovery」）。計時完全經由注入的 Clock。
 */
import type { Clock, TimerHandle } from '../../clock/types';
import type { ExchangeId } from '../../types/ids';
import type { EventSink } from '../instruments/types';
import { Backoff, type BackoffConfig } from '../backoff';
import type { MinimalWebSocket, ParsedMessage, WebSocketFactory } from '../types';

export type ConnectionState = 'IDLE' | 'CONNECTING' | 'OPEN' | 'RECONNECT_WAIT' | 'CLOSED';

export interface WsConnectionDeps {
  clock: Clock;
  eventSink: EventSink;
  exchange: ExchangeId;
  connection_id: string;
  wsFactory: WebSocketFactory;
  url: string;
  heartbeat: { client_ping_interval_ms?: number; ping_payload?: string; idle_timeout_ms: number };
  parse(raw: string, local_received: number): ParsedMessage[];
  buildSubscribe(topics: string[]): string;
  buildUnsubscribe(topics: string[]): string;
  onMessage(msgs: ParsedMessage[]): void;
  /** 重連成功（非首次連線）後呼叫，供呼叫端觸發回補快照。 */
  onReconnected?(topics: string[]): void;
  backoff: BackoffConfig;
  /** `backoff_reset_after_ms`，預設 60,000。 */
  backoff_reset_after_ms: number;
}

export class WsConnection {
  state: ConnectionState = 'IDLE';
  private ws: MinimalWebSocket | null = null;
  private topics = new Set<string>();
  private readonly backoff: Backoff;
  private idleTimer: TimerHandle | null = null;
  private pingTimer: TimerHandle | null = null;
  private stabilityTimer: TimerHandle | null = null;
  private lastMessageAt = 0;
  private hasConnectedBefore = false;
  private closedIntentionally = false;

  constructor(private readonly deps: WsConnectionDeps) {
    this.backoff = new Backoff(deps.backoff);
  }

  private emitStateChange(from: ConnectionState, to: ConnectionState, reason: string): void {
    this.deps.eventSink.emit({
      event_id: crypto.randomUUID(),
      event_type: 'FEED_STATE_CHANGED',
      timestamp: this.deps.clock.now(),
      recorded_at: this.deps.clock.now(),
      exchange: this.deps.exchange,
      trade_id: null,
      payload: { from, to, reason, connection_id: this.deps.connection_id },
    });
  }

  private transition(to: ConnectionState, reason: string): void {
    const from = this.state;
    this.state = to;
    if (from !== to) this.emitStateChange(from, to, reason);
  }

  connect(topics: string[] = [...this.topics]): void {
    this.topics = new Set(topics);
    this.closedIntentionally = false;
    this.transition('CONNECTING', this.hasConnectedBefore ? 'RECONNECT' : 'INITIAL');
    const ws = this.deps.wsFactory(this.deps.url);
    this.ws = ws;
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = (ev) => this.handleClose(ev.code, ev.reason);
    ws.onerror = () => {
      /* onclose 緊接而來，狀態轉換在那裡處理 */
    };
  }

  private handleOpen(): void {
    this.lastMessageAt = this.deps.clock.now();
    if (this.topics.size > 0) {
      this.ws!.send(this.deps.buildSubscribe([...this.topics]));
      // 等待 ACK（handleMessage 中轉為 OPEN）；仍須先武裝 idle 偵測避免握手後無任何回應。
      this.resetIdleTimer();
      return;
    }
    this.becomeOpen();
  }

  private becomeOpen(): void {
    const wasReconnect = this.hasConnectedBefore;
    this.transition('OPEN', wasReconnect ? 'RECONNECTED' : 'CONNECTED');
    this.hasConnectedBefore = true;
    // backoff 只在維持 OPEN 達 backoff_reset_after_ms 後才歸零（armStabilityTimer），
    // 避免「連上又立刻斷」被誤判為穩定。
    this.armHeartbeat();
    this.armStabilityTimer();
    if (wasReconnect) this.deps.onReconnected?.([...this.topics]);
  }

  private handleMessage(raw: string): void {
    const now = this.deps.clock.now();
    this.lastMessageAt = now;
    this.resetIdleTimer();
    const msgs = this.deps.parse(raw, now);
    const forward: ParsedMessage[] = [];
    let ackReceived = false;
    for (const m of msgs) {
      if (m.kind === 'ACK') {
        ackReceived = true;
        continue;
      }
      if (m.kind === 'PONG' || m.kind === 'IGNORED') continue;
      forward.push(m);
    }
    if (ackReceived && this.state === 'CONNECTING') this.becomeOpen();
    if (forward.length > 0) this.deps.onMessage(forward);
  }

  private handleClose(code: number, reason: string): void {
    const wasOpen = this.state === 'OPEN';
    this.clearTimers();
    if (wasOpen && !this.closedIntentionally) {
      this.deps.eventSink.emit({
        event_id: crypto.randomUUID(),
        event_type: 'EXCHANGE_DISCONNECTED',
        timestamp: this.deps.clock.now(),
        recorded_at: this.deps.clock.now(),
        exchange: this.deps.exchange,
        trade_id: null,
        payload: { code, reason, connection_id: this.deps.connection_id },
      });
    }
    if (this.closedIntentionally) {
      this.transition('CLOSED', reason || 'CLOSED');
      return;
    }
    this.transition('RECONNECT_WAIT', reason || `CLOSE_${code}`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const waitMs = this.backoff.next();
    this.deps.clock.after(waitMs, () => {
      if (this.state === 'RECONNECT_WAIT') this.connect([...this.topics]);
    });
  }

  /** 由呼叫端主動關閉（例：先建後拆輪替時關閉舊連線），不觸發重連或 EXCHANGE_DISCONNECTED。 */
  closeIntentionally(reason: string): void {
    this.closedIntentionally = true;
    this.clearTimers();
    this.ws?.close(1000, reason);
  }

  private armHeartbeat(): void {
    const { client_ping_interval_ms, ping_payload, idle_timeout_ms } = this.deps.heartbeat;
    if (client_ping_interval_ms) {
      const sendPing = (): void => {
        if (this.state !== 'OPEN') return;
        this.ws?.send(ping_payload ?? JSON.stringify({ op: 'ping' }));
        this.pingTimer = this.deps.clock.after(client_ping_interval_ms, sendPing);
      };
      this.pingTimer = this.deps.clock.after(client_ping_interval_ms, sendPing);
    }
    void idle_timeout_ms;
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) this.deps.clock.cancel(this.idleTimer);
    const idleMs = this.deps.heartbeat.idle_timeout_ms;
    this.idleTimer = this.deps.clock.after(idleMs, () => {
      const elapsed = this.deps.clock.now() - this.lastMessageAt;
      if (elapsed >= idleMs && (this.state === 'OPEN' || this.state === 'CONNECTING')) {
        // close() 觸發 onclose → handleClose()（真實 WebSocket 與 FakeWebSocket 皆經同一路徑）。
        this.ws?.close(4000, 'IDLE_TIMEOUT');
      }
    });
  }

  private armStabilityTimer(): void {
    if (this.stabilityTimer) this.deps.clock.cancel(this.stabilityTimer);
    this.stabilityTimer = this.deps.clock.after(this.deps.backoff_reset_after_ms, () => {
      if (this.state === 'OPEN') this.backoff.reset();
    });
  }

  private clearTimers(): void {
    if (this.idleTimer) this.deps.clock.cancel(this.idleTimer);
    if (this.pingTimer) this.deps.clock.cancel(this.pingTimer);
    if (this.stabilityTimer) this.deps.clock.cancel(this.stabilityTimer);
    this.idleTimer = null;
    this.pingTimer = null;
    this.stabilityTimer = null;
  }

  currentTopics(): string[] {
    return [...this.topics];
  }

  reconnectAttempts(): number {
    return this.backoff.attemptCount();
  }
}
