/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GuardedRestClient（market-data-snapshot spec，design.md Decision 7）：實作
 * `PublicRestClient`。request ─▶ circuit breaker ─▶ single-flight ─▶ rate limiter
 * ─▶ fetch（timeout）─▶ 分類 ─▶ 更新 SourceStatus / 用量 / 斷路器。
 */
import type { Clock } from '../../clock/types';
import type { ExchangeId } from '../../types/ids';
import type { EventSink } from '../instruments/types';
import type { RateLimitRule } from '../types';
import { RateLimiter } from './rateLimiter';
import type { PublicRestClient, RestRequest, RestResult } from './publicRestClient';
import { UpstreamError } from './publicRestClient';
import { SourceStatusTracker } from '../sourceStatus';

export interface EnvelopeErrorChecker {
  (exchange: ExchangeId, body: unknown): string | null;
}

export interface GuardedRestClientDeps {
  clock: Clock;
  eventSink: EventSink;
  /** 每所限流規則表（adapter 宣告）。 */
  rateLimitRules: Record<ExchangeId, RateLimitRule[]>;
  sourceStatus: SourceStatusTracker;
  /** 交易所信封錯誤判定（由 adapter 的 `rest.envelopeError` 轉接，單一函式避免交易所分支）。 */
  envelopeError?: EnvelopeErrorChecker;
  fetchImpl?: typeof fetch;
  /** `rate_limit_soft_ratio`，預設 0.7。 */
  soft_ratio?: number;
}

const RATE_LIMITED_STATUSES = new Set([429, 418, 403]);

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.after(ms, resolve));
}

export class GuardedRestClient implements PublicRestClient {
  private readonly limiters = new Map<ExchangeId, RateLimiter>();
  private readonly inFlight = new Map<string, Promise<RestResult<unknown>>>();

  constructor(private readonly deps: GuardedRestClientDeps) {}

  private limiterFor(exchange: ExchangeId): RateLimiter {
    let limiter = this.limiters.get(exchange);
    if (!limiter) {
      limiter = new RateLimiter({
        clock: this.deps.clock,
        eventSink: this.deps.eventSink,
        exchange,
        rules: this.deps.rateLimitRules[exchange] ?? [],
        soft_ratio: this.deps.soft_ratio,
      });
      this.limiters.set(exchange, limiter);
    }
    return limiter;
  }

  rateLimiter(exchange: ExchangeId): RateLimiter {
    return this.limiterFor(exchange);
  }

  private key(req: RestRequest): string {
    return `${req.exchange}:${req.url}`;
  }

  /** `queryServerTime` 等場景需要獨立往返時間樣本，MUST NOT single-flight；
   * 仍計入限流與斷路器。 */
  async getJsonNoCoalesce<T>(req: RestRequest): Promise<RestResult<T>> {
    return this.execute<T>(req);
  }

  async getJson<T>(req: RestRequest): Promise<RestResult<T>> {
    const key = this.key(req);
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<RestResult<T>>;

    const promise = this.execute<T>(req).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise as Promise<RestResult<unknown>>);
    return promise;
  }

  private async execute<T>(req: RestRequest): Promise<RestResult<T>> {
    const limiter = this.limiterFor(req.exchange);

    // circuit breaker + single admission loop（OVER_LIMIT 延後重試視窗，CIRCUIT_OPEN 立即拒絕）。
    let wasProbe = false;
    for (;;) {
      const admission = limiter.admitRequest(req.weight ?? 1);
      if (admission.allowed) {
        wasProbe = limiter.circuitState() === 'HALF_OPEN';
        break;
      }
      if (admission.reason === 'CIRCUIT_OPEN') {
        throw new UpstreamError({ exchange: req.exchange, kind: 'RATE_LIMITED', message: `circuit open for ${req.exchange}` });
      }
      await sleep(this.deps.clock, admission.wait_ms);
    }

    const local_sent = this.deps.clock.now();
    const timeoutMs = req.timeout_ms ?? 6000;
    const fetchImpl = this.deps.fetchImpl ?? fetch;

    let res: Response;
    try {
      res = await fetchImpl(req.url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const kind = isTimeout ? 'TIMEOUT' : 'NETWORK';
      this.deps.sourceStatus.recordFailure(req.exchange, kind, undefined, this.hasUsableData(req.exchange));
      if (wasProbe) limiter.onProbeResult(false);
      throw new UpstreamError({
        exchange: req.exchange,
        kind,
        message: isTimeout ? `request timed out after ${timeoutMs}ms: ${req.url}` : `network error for ${req.url}: ${(err as Error).message}`,
        cause: err,
      });
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((value, k) => {
      headers[k.toLowerCase()] = value;
    });
    limiter.recordUsageFromHeaders(headers);

    if (!res.ok) {
      const retryAfterHeader = headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;

      if (RATE_LIMITED_STATUSES.has(res.status)) {
        limiter.onBlockResponse(res.status, retryAfterMs);
        this.deps.sourceStatus.updateRateLimit(req.exchange, limiter.status());
        this.deps.sourceStatus.recordFailure(req.exchange, 'RATE_LIMITED', res.status, this.hasUsableData(req.exchange));
        this.logNon2xx(req, res.status, local_sent);
        // onBlockResponse 已依規則冷卻時間轉換斷路器狀態；探測期間再次被封鎖不重複加倍。
        throw new UpstreamError({ exchange: req.exchange, kind: 'RATE_LIMITED', message: `rate limited: HTTP ${res.status} for ${req.url}`, http_status: res.status, retry_after_ms: retryAfterMs });
      }

      this.deps.sourceStatus.recordFailure(req.exchange, 'HTTP', res.status, this.hasUsableData(req.exchange));
      this.logNon2xx(req, res.status, local_sent);
      if (wasProbe) limiter.onProbeResult(false);
      throw new UpstreamError({ exchange: req.exchange, kind: 'HTTP', message: `HTTP ${res.status} for ${req.url}`, http_status: res.status });
    }

    let data: T;
    try {
      data = (await res.json()) as T;
    } catch (err) {
      this.deps.sourceStatus.recordFailure(req.exchange, 'PARSE', res.status, this.hasUsableData(req.exchange));
      if (wasProbe) limiter.onProbeResult(false);
      throw new UpstreamError({ exchange: req.exchange, kind: 'PARSE', message: `failed to parse JSON from ${req.url}: ${(err as Error).message}`, http_status: res.status, cause: err });
    }

    const envelopeMsg = this.deps.envelopeError?.(req.exchange, data) ?? null;
    if (envelopeMsg !== null) {
      this.deps.sourceStatus.recordFailure(req.exchange, 'API_ERROR', res.status, this.hasUsableData(req.exchange));
      this.logNon2xx(req, res.status, local_sent);
      if (wasProbe) limiter.onProbeResult(false);
      throw new UpstreamError({ exchange: req.exchange, kind: 'API_ERROR', message: `envelope error for ${req.url}: ${envelopeMsg}`, http_status: res.status });
    }

    if (wasProbe) limiter.onProbeResult(true);
    this.deps.sourceStatus.updateRateLimit(req.exchange, limiter.status());

    return {
      data,
      http_status: res.status,
      headers,
      local_sent,
      local_received: this.deps.clock.now(),
    };
  }

  private hasUsableData(exchange: ExchangeId): boolean {
    const status = this.deps.sourceStatus.get(exchange);
    return (status?.instrument_count ?? 0) > 0;
  }

  private logNon2xx(req: RestRequest, http_status: number, local_sent: number): void {
    const latency_ms = this.deps.clock.now() - local_sent;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({ level: 'warn', component: 'GuardedRestClient', exchange: req.exchange, url_path: new URL(req.url).pathname, http_status, latency_ms }),
    );
  }
}
