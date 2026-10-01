/**
 * runtime/src/telemetry/eventQueue.ts
 *
 * Non-blocking Event Queue (design.md Decision 5, tech spec §35 / spec
 * "Non-blocking event queue"). `publish` only pushes to per-consumer
 * buffers — it never calls a consumer itself, so it can never block on a
 * slow/throwing `DatabaseWriter` / `UiBroadcaster` / `AnalyticsWriter`.
 * Delivery happens on Clock-scheduled flush ticks: the DB chain retries with
 * exponential backoff and never drops events; the UI buffer is capped and
 * drops the oldest entries past the cap (counted); analytics is best-effort
 * and isolated (consumer errors are counted, never thrown back to the
 * caller or allowed to block the DB chain).
 */
import type { TradingEvent } from '../types/event';

export interface EventConsumers {
  writeToDb(batch: TradingEvent[]): void;
  broadcastToUi(event: TradingEvent): void;
  writeAnalytics(event: TradingEvent): void;
}

export interface EventQueueConfig {
  /** `event_flush_interval_ms`; default 50. */
  flushIntervalMs?: number;
  /** `event_flush_batch_size`; default 100. */
  flushBatchSize?: number;
  /** `event_queue_max`; default 10 000 — DB buffer length that triggers `overflow = true` (events are still kept). */
  dbQueueMax?: number;
  /** UI buffer cap; default 1 000 — oldest entries are dropped past this. */
  uiBufferMax?: number;
  /** Initial DB-write retry backoff; default 100 ms. */
  retryInitialMs?: number;
  /** Maximum DB-write retry backoff; default 5 000 ms. */
  retryMaxMs?: number;
}

export interface EventQueueStatus {
  pending: number;
  overflow: boolean;
  lastFlushAt: number | null;
  lastError: string | null;
  consumerErrors: { db: number; ui: number; analytics: number };
  uiDropped: number;
}

interface QueueClock {
  now(): number;
  after(ms: number, cb: () => void): unknown;
}

const DEFAULTS: Required<EventQueueConfig> = {
  flushIntervalMs: 50,
  flushBatchSize: 100,
  dbQueueMax: 10_000,
  uiBufferMax: 1_000,
  retryInitialMs: 100,
  retryMaxMs: 5_000,
};

export class EventQueue {
  private readonly cfg: Required<EventQueueConfig>;
  private dbBuffer: TradingEvent[] = [];
  private uiBuffer: TradingEvent[] = [];
  private analyticsBuffer: TradingEvent[] = [];
  private uiDropped = 0;
  private overflow = false;
  private lastFlushAt: number | null = null;
  private lastError: string | null = null;
  private consumerErrors = { db: 0, ui: 0, analytics: 0 };
  private dbRetryDelayMs: number | null = null;
  private closed = false;

  constructor(
    private readonly clock: QueueClock,
    private readonly consumers: EventConsumers,
    config: EventQueueConfig = {},
  ) {
    this.cfg = { ...DEFAULTS, ...config };
    this.scheduleUiAnalyticsTick();
    this.scheduleDbFlush(this.cfg.flushIntervalMs);
  }

  /** O(1), never calls a consumer — safe to call from the trading core's hot path. */
  publish(event: TradingEvent): void {
    this.dbBuffer.push(event);
    if (this.dbBuffer.length > this.cfg.dbQueueMax) {
      this.overflow = true;
    }
    this.uiBuffer.push(event);
    if (this.uiBuffer.length > this.cfg.uiBufferMax) {
      this.uiBuffer.shift();
      this.uiDropped += 1;
    }
    this.analyticsBuffer.push(event);
  }

  getStatus(): EventQueueStatus {
    return {
      pending: this.dbBuffer.length,
      overflow: this.overflow,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
      consumerErrors: { ...this.consumerErrors },
      uiDropped: this.uiDropped,
    };
  }

  /** Graceful shutdown: synchronously flushes all pending DB events, then UI/analytics, before the DB may be closed. */
  drain(): void {
    while (this.dbBuffer.length > 0) {
      const batch = this.dbBuffer.slice(0, this.cfg.flushBatchSize);
      this.consumers.writeToDb(batch);
      this.dbBuffer.splice(0, batch.length);
    }
    this.lastFlushAt = this.clock.now();
    this.overflow = false;
    this.flushUi();
    this.flushAnalytics();
    this.closed = true;
  }

  private scheduleUiAnalyticsTick(): void {
    if (this.closed) return;
    this.clock.after(this.cfg.flushIntervalMs, () => {
      this.flushUi();
      this.flushAnalytics();
      this.scheduleUiAnalyticsTick();
    });
  }

  private flushUi(): void {
    const batch = this.uiBuffer;
    this.uiBuffer = [];
    for (const event of batch) {
      try {
        this.consumers.broadcastToUi(event);
      } catch {
        this.consumerErrors.ui += 1;
      }
    }
  }

  private flushAnalytics(): void {
    const batch = this.analyticsBuffer;
    this.analyticsBuffer = [];
    for (const event of batch) {
      try {
        this.consumers.writeAnalytics(event);
      } catch {
        this.consumerErrors.analytics += 1;
      }
    }
  }

  private scheduleDbFlush(delay: number): void {
    if (this.closed) return;
    this.clock.after(delay, () => this.attemptDbFlush());
  }

  private attemptDbFlush(): void {
    if (this.dbBuffer.length === 0) {
      this.dbRetryDelayMs = null;
      this.scheduleDbFlush(this.cfg.flushIntervalMs);
      return;
    }
    const batch = this.dbBuffer.slice(0, this.cfg.flushBatchSize);
    try {
      this.consumers.writeToDb(batch);
      this.dbBuffer.splice(0, batch.length);
      this.lastFlushAt = this.clock.now();
      this.lastError = null;
      this.dbRetryDelayMs = null;
      if (this.dbBuffer.length <= this.cfg.dbQueueMax) {
        this.overflow = false;
      }
      this.scheduleDbFlush(this.cfg.flushIntervalMs);
    } catch (err) {
      this.consumerErrors.db += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      const next = this.dbRetryDelayMs ? Math.min(this.dbRetryDelayMs * 2, this.cfg.retryMaxMs) : this.cfg.retryInitialMs;
      this.dbRetryDelayMs = next;
      this.scheduleDbFlush(next);
    }
  }
}
