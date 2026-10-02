/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 每所 SourceStatus 狀態機（market-data-snapshot spec「Per-exchange source
 * status」）。不得以交易所名稱做條件分支（呼叫端傳入 ExchangeId，本模組不 switch）。
 */
import type { ExchangeId } from '../types/ids';
import type { EventSink } from './instruments/types';
import type { CircuitState, SourceStatus, SourceStatusState } from './types';

export interface SourceStatusTrackerDeps {
  eventSink: EventSink;
  now(): number;
}

function computeState(params: {
  hasUsableData: boolean;
  consecutiveFailures: number;
  circuit: CircuitState | null;
}): SourceStatusState {
  if (params.circuit === 'OPEN') return 'RATE_LIMITED';
  if (!params.hasUsableData) return params.consecutiveFailures === 0 ? 'INITIALIZING' : 'FAILED';
  return params.consecutiveFailures === 0 ? 'HEALTHY' : 'DEGRADED';
}

export class SourceStatusTracker {
  private readonly statuses = new Map<ExchangeId, SourceStatus>();

  constructor(private readonly deps: SourceStatusTrackerDeps) {}

  private ensure(exchange: ExchangeId): SourceStatus {
    const existing = this.statuses.get(exchange);
    if (existing) return existing;
    const now = this.deps.now();
    const created: SourceStatus = {
      exchange,
      state: 'INITIALIZING',
      last_success_at: null,
      last_error: null,
      consecutive_failures: 0,
      data_age_ms: null,
      instrument_count: 0,
      rate_limit: null,
      created_at: now,
      updated_at: now,
    };
    this.statuses.set(exchange, created);
    return created;
  }

  get(exchange: ExchangeId): SourceStatus | undefined {
    return this.statuses.get(exchange);
  }

  all(): SourceStatus[] {
    return [...this.statuses.values()];
  }

  private applyTransition(exchange: ExchangeId, next: SourceStatus, reason: string): void {
    const prev = this.ensure(exchange);
    const from = prev.state;
    this.statuses.set(exchange, next);
    if (from !== next.state) {
      this.deps.eventSink.emit({
        event_id: crypto.randomUUID(),
        event_type: 'SOURCE_STATUS_CHANGED',
        timestamp: next.updated_at,
        recorded_at: next.updated_at,
        exchange,
        trade_id: null,
        payload: { from, to: next.state, reason },
      });
    }
  }

  /** 有可用資料（最後成功資料未超齡）時呼叫，不論本次請求是否成功。 */
  recordSuccess(exchange: ExchangeId, instrument_count: number, hasUsableData = true): void {
    const prev = this.ensure(exchange);
    const now = this.deps.now();
    const circuit = prev.rate_limit?.circuit ?? null;
    const next: SourceStatus = {
      ...prev,
      last_success_at: now,
      last_error: null,
      consecutive_failures: 0,
      data_age_ms: 0,
      instrument_count,
      updated_at: now,
      state: computeState({ hasUsableData, consecutiveFailures: 0, circuit }),
    };
    this.applyTransition(exchange, next, 'SUCCESS');
  }

  /** 失敗但仍有未超齡最後成功資料時維持 DEGRADED（hasUsableData=true）。 */
  recordFailure(exchange: ExchangeId, kind: string, http_status: number | undefined, hasUsableData: boolean): void {
    const prev = this.ensure(exchange);
    const now = this.deps.now();
    const circuit = prev.rate_limit?.circuit ?? null;
    const consecutive_failures = prev.consecutive_failures + 1;
    const next: SourceStatus = {
      ...prev,
      last_error: { kind, http_status, at: now },
      consecutive_failures,
      instrument_count: hasUsableData ? prev.instrument_count : 0,
      updated_at: now,
      state: computeState({ hasUsableData, consecutiveFailures: consecutive_failures, circuit }),
    };
    this.applyTransition(exchange, next, kind);
  }

  /** 最後成功資料超過 max_last_known_good_age_ms，被行情狀態移除（market-data-snapshot spec）。 */
  recordDataExpired(exchange: ExchangeId): void {
    const prev = this.ensure(exchange);
    const now = this.deps.now();
    const next: SourceStatus = {
      ...prev,
      instrument_count: 0,
      data_age_ms: null,
      updated_at: now,
      state: 'FAILED',
    };
    this.applyTransition(exchange, next, 'DATA_EXPIRED');
  }

  updateDataAge(exchange: ExchangeId, data_age_ms: number | null): void {
    const prev = this.ensure(exchange);
    this.statuses.set(exchange, { ...prev, data_age_ms, updated_at: this.deps.now() });
  }

  updateRateLimit(exchange: ExchangeId, rate_limit: SourceStatus['rate_limit']): void {
    const prev = this.ensure(exchange);
    const now = this.deps.now();
    const hasUsableData = prev.instrument_count > 0;
    const next: SourceStatus = {
      ...prev,
      rate_limit,
      updated_at: now,
      state: computeState({
        hasUsableData,
        consecutiveFailures: prev.consecutive_failures,
        circuit: rate_limit?.circuit ?? null,
      }),
    };
    this.applyTransition(exchange, next, 'RATE_LIMIT_UPDATE');
  }
}
