/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 每所限流規則表、標頭用量追蹤、斷路器（market-data-snapshot spec「Rate-limit
 * rules and budget」「Circuit breaker on rate-limit responses」）。
 * 計時完全經由注入的 Clock，不得直接呼叫 Date.now（Invariant #3 / 架構守門）。
 */
import type { Clock } from '../../clock/types';
import type { ExchangeId } from '../../types/ids';
import type { EventSink } from '../instruments/types';
import type { CircuitState, RateLimitRule, SourceStatus } from '../types';

export interface RateLimiterDeps {
  clock: Clock;
  eventSink: EventSink;
  exchange: ExchangeId;
  rules: RateLimitRule[];
  /** `rate_limit_soft_ratio`，預設 0.7。 */
  soft_ratio?: number;
}

export type RequestAdmission =
  | { allowed: true }
  | { allowed: false; reason: 'CIRCUIT_OPEN' | 'OVER_LIMIT'; wait_ms: number };

interface RuleUsage {
  rule: RateLimitRule;
  window_start: number;
  used: number;
  /** true 代表這條規則的用量來自標頭回報，而非本地計數。 */
  from_header: boolean;
}

const DEFAULT_SOFT_RATIO = 0.7;
const RECOVER_RATIO = 0.5;

export class RateLimiter {
  private readonly usages: RuleUsage[];
  private circuit: CircuitState = 'CLOSED';
  private openUntil = 0;
  private currentCooldownMs = 0;
  private halfOpenProbeInFlight = false;
  private softCapActive = false;

  constructor(private readonly deps: RateLimiterDeps) {
    this.usages = deps.rules.map((rule) => ({ rule, window_start: deps.clock.now(), used: 0, from_header: false }));
  }

  private emitCircuitChange(from: CircuitState, to: CircuitState): void {
    this.deps.eventSink.emit({
      event_id: crypto.randomUUID(),
      event_type: 'RATE_LIMIT_CIRCUIT_CHANGED',
      timestamp: this.deps.clock.now(),
      recorded_at: this.deps.clock.now(),
      exchange: this.deps.exchange,
      trade_id: null,
      payload: { from, to },
    });
  }

  private openCircuit(cooldownMs: number): void {
    const from = this.circuit;
    this.circuit = 'OPEN';
    this.currentCooldownMs = cooldownMs;
    this.openUntil = this.deps.clock.now() + cooldownMs;
    this.halfOpenProbeInFlight = false;
    if (from !== 'OPEN') this.emitCircuitChange(from, 'OPEN');
  }

  /** 呼叫端在送出請求前先呼叫；OPEN 期間立即拒絕，到期轉 HALF_OPEN 只放行一個探測請求。 */
  admitRequest(weight = 1): RequestAdmission {
    const now = this.deps.clock.now();

    if (this.circuit === 'OPEN') {
      if (now < this.openUntil) {
        return { allowed: false, reason: 'CIRCUIT_OPEN', wait_ms: this.openUntil - now };
      }
      const from = this.circuit;
      this.circuit = 'HALF_OPEN';
      this.emitCircuitChange(from, 'HALF_OPEN');
    }

    if (this.circuit === 'HALF_OPEN') {
      if (this.halfOpenProbeInFlight) {
        return { allowed: false, reason: 'CIRCUIT_OPEN', wait_ms: 1 };
      }
      this.halfOpenProbeInFlight = true;
      return { allowed: true };
    }

    // CLOSED：檢查每條規則視窗用量，任一超過即延後到視窗重置。
    for (const usage of this.usages) {
      this.rollWindow(usage, now);
      if (usage.used + weight > usage.rule.limit) {
        const waitMs = usage.window_start + usage.rule.window_ms - now;
        return { allowed: false, reason: 'OVER_LIMIT', wait_ms: Math.max(waitMs, 1) };
      }
    }
    for (const usage of this.usages) {
      if (!usage.from_header) usage.used += weight;
    }
    return { allowed: true };
  }

  private rollWindow(usage: RuleUsage, now: number): void {
    if (now - usage.window_start >= usage.rule.window_ms) {
      usage.window_start = now;
      usage.used = 0;
      usage.from_header = false;
    }
  }

  /** 以回應標頭更新用量（例：Binance `X-MBX-USED-WEIGHT-1M`）。 */
  recordUsageFromHeaders(headers: Record<string, string>): void {
    for (const usage of this.usages) {
      const headerName = usage.rule.usage_header?.toLowerCase();
      if (!headerName) continue;
      const raw = headers[headerName] ?? headers[usage.rule.usage_header!];
      if (raw === undefined) continue;
      const used = Number(raw);
      if (!Number.isFinite(used)) continue;
      usage.used = used;
      usage.from_header = true;
    }
    this.updateSoftCap();
  }

  private updateSoftCap(): void {
    const ratio = this.usageRatio();
    if (ratio >= (this.deps.soft_ratio ?? DEFAULT_SOFT_RATIO)) {
      this.softCapActive = true;
    } else if (ratio < RECOVER_RATIO) {
      this.softCapActive = false;
    }
  }

  /** 全部規則中最大用量比例。 */
  usageRatio(): number {
    let max = 0;
    for (const usage of this.usages) {
      if (usage.rule.limit <= 0) continue;
      max = Math.max(max, usage.used / usage.rule.limit);
    }
    return max;
  }

  /** 軟上限生效時輪詢間隔應加倍，直到用量 < 0.5 恢復（遲滯）。 */
  pollIntervalMultiplier(): number {
    return this.softCapActive ? 2 : 1;
  }

  /** 收到封鎖回應（HTTP 429/418/403 等，由規則表宣告）時呼叫。 */
  onBlockResponse(http_status: number, retry_after_ms: number | undefined): void {
    const rule = this.deps.rules.find((r) => r.block_statuses.includes(http_status));
    const ruleCooldown = rule?.cooldown_ms ?? 60_000;
    const cooldown = Math.max(retry_after_ms ?? 0, ruleCooldown);
    this.openCircuit(cooldown);
  }

  /** HALF_OPEN 探測請求的結果。 */
  onProbeResult(success: boolean): void {
    this.halfOpenProbeInFlight = false;
    if (success) {
      const from = this.circuit;
      this.circuit = 'CLOSED';
      this.currentCooldownMs = 0;
      if (from !== 'CLOSED') this.emitCircuitChange(from, 'CLOSED');
    } else {
      this.openCircuit(Math.max(this.currentCooldownMs * 2, 1000));
    }
  }

  status(): NonNullable<SourceStatus['rate_limit']> {
    const primary = this.usages[0];
    return {
      used: primary ? primary.used : 0,
      limit: primary ? primary.rule.limit : 0,
      window_ms: primary ? primary.rule.window_ms : 0,
      circuit: this.circuit,
    };
  }

  circuitState(): CircuitState {
    return this.circuit;
  }
}
