/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 主題分片與連線輪替（market-data-stream spec「Connection rotation and topic
 * sharding」）。把一組主題分散到多條 `WsConnection`，並在連線壽命到期前
 * `rotation_lead_ms` 先建新連線、完成訂閱後才關閉舊連線（先建後拆）。
 */
import type { Clock, TimerHandle } from '../../clock/types';
import type { ExchangeId } from '../../types/ids';
import type { EventSink } from '../instruments/types';
import type { BackoffConfig } from '../backoff';
import type { ParsedMessage, WebSocketFactory } from '../types';
import { WsConnection } from './wsConnection';

export interface ConnectionPoolDeps {
  clock: Clock;
  eventSink: EventSink;
  exchange: ExchangeId;
  wsFactory: WebSocketFactory;
  url: string;
  heartbeat: { client_ping_interval_ms?: number; ping_payload?: string; idle_timeout_ms: number };
  parse(raw: string, local_received: number): ParsedMessage[];
  buildSubscribe(topics: string[]): string;
  buildUnsubscribe(topics: string[]): string;
  onMessage(msgs: ParsedMessage[]): void;
  onReconnected?(topics: string[]): void;
  backoff: BackoffConfig;
  backoff_reset_after_ms: number;
  max_topics_per_connection?: number;
  max_connection_lifetime_ms?: number;
  /** `rotation_lead_ms`，預設 5 分鐘。 */
  rotation_lead_ms?: number;
}

interface ManagedConnection {
  id: string;
  conn: WsConnection;
  createdAt: number;
  rotationTimer: TimerHandle | null;
}

const DEFAULT_ROTATION_LEAD_MS = 5 * 60_000;

export class ConnectionPool {
  private readonly managed: ManagedConnection[] = [];
  private nextId = 1;

  constructor(private readonly deps: ConnectionPoolDeps) {}

  private createConnection(topics: string[]): ManagedConnection {
    const id = `${this.deps.exchange}-${this.nextId++}`;
    const conn = new WsConnection({
      clock: this.deps.clock,
      eventSink: this.deps.eventSink,
      exchange: this.deps.exchange,
      connection_id: id,
      wsFactory: this.deps.wsFactory,
      url: this.deps.url,
      heartbeat: this.deps.heartbeat,
      parse: this.deps.parse,
      buildSubscribe: this.deps.buildSubscribe,
      buildUnsubscribe: this.deps.buildUnsubscribe,
      onMessage: this.deps.onMessage,
      onReconnected: this.deps.onReconnected,
      backoff: this.deps.backoff,
      backoff_reset_after_ms: this.deps.backoff_reset_after_ms,
    });
    const managed: ManagedConnection = { id, conn, createdAt: this.deps.clock.now(), rotationTimer: null };
    this.managed.push(managed);
    conn.connect(topics);
    this.armRotation(managed);
    return managed;
  }

  private armRotation(managed: ManagedConnection): void {
    if (!this.deps.max_connection_lifetime_ms) return;
    const leadMs = this.deps.rotation_lead_ms ?? DEFAULT_ROTATION_LEAD_MS;
    const rotateAt = managed.createdAt + this.deps.max_connection_lifetime_ms - leadMs;
    managed.rotationTimer = this.deps.clock.at(Math.max(rotateAt, this.deps.clock.now()), () => this.rotate(managed));
  }

  private rotate(oldManaged: ManagedConnection): void {
    const topics = oldManaged.conn.currentTopics();
    const newManaged = this.createConnection(topics);
    // 先建後拆：等新連線 OPEN 後才關閉舊連線。以輪詢方式偵測（VirtualClock 下由測試推進）。
    const checkAndClose = (): void => {
      if (newManaged.conn.state === 'OPEN') {
        oldManaged.conn.closeIntentionally('ROTATION');
        const idx = this.managed.indexOf(oldManaged);
        if (idx >= 0) this.managed.splice(idx, 1);
        return;
      }
      this.deps.clock.after(100, checkAndClose);
    };
    checkAndClose();
  }

  /** 將主題分片到現有 / 新建連線（上限 `max_topics_per_connection`）。 */
  subscribe(topics: string[]): void {
    const perConn = this.deps.max_topics_per_connection ?? Infinity;
    let remaining = [...topics];

    for (const managed of this.managed) {
      if (remaining.length === 0) break;
      const current = managed.conn.currentTopics();
      const capacity = perConn - current.length;
      if (capacity <= 0) continue;
      const take = remaining.splice(0, capacity);
      managed.conn.connect([...current, ...take]);
    }

    while (remaining.length > 0) {
      const take = remaining.splice(0, perConn === Infinity ? remaining.length : perConn);
      this.createConnection(take);
    }
  }

  connections(): WsConnection[] {
    return this.managed.map((m) => m.conn);
  }
}
