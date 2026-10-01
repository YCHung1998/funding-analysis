/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 最小 REST 讀取埠（design.md Decision 8）。websocket-data-layer 會以同一介面提供
 * single-flight / 限流預算 / 斷路器的 GuardedRestClient，本檔不需修改。
 */

import type { ExchangeId } from '../instruments/types';

export interface RestRequest {
  exchange: ExchangeId;
  url: string;
  weight?: number;
  timeout_ms?: number;
}

export interface RestResult<T> {
  data: T;
  http_status: number;
  headers: Record<string, string>;
  local_sent: number;
  local_received: number;
}

export type UpstreamErrorKind = 'HTTP' | 'TIMEOUT' | 'NETWORK' | 'PARSE' | 'API_ERROR' | 'RATE_LIMITED';

export class UpstreamError extends Error {
  exchange: ExchangeId;
  kind: UpstreamErrorKind;
  http_status?: number;
  retry_after_ms?: number;

  constructor(params: {
    exchange: ExchangeId;
    kind: UpstreamErrorKind;
    message: string;
    http_status?: number;
    retry_after_ms?: number;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = 'UpstreamError';
    this.exchange = params.exchange;
    this.kind = params.kind;
    this.http_status = params.http_status;
    this.retry_after_ms = params.retry_after_ms;
  }
}

export interface PublicRestClient {
  getJson<T>(req: RestRequest): Promise<RestResult<T>>;
}

export interface BasicRestClientDeps {
  /** 以參數注入，不直接讀系統時間（runtime 架構規則）。 */
  localNow: () => number;
  fetchImpl?: typeof fetch;
}

const RATE_LIMITED_STATUSES = new Set([429, 418, 403]);

export class BasicRestClient implements PublicRestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly localNow: () => number;

  constructor(deps: BasicRestClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.localNow = deps.localNow;
  }

  async getJson<T>(req: RestRequest): Promise<RestResult<T>> {
    const localSent = this.localNow();
    const timeoutMs = req.timeout_ms ?? 6000;

    let res: Response;
    try {
      res = await this.fetchImpl(req.url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new UpstreamError({
        exchange: req.exchange,
        kind: isTimeout ? 'TIMEOUT' : 'NETWORK',
        message: isTimeout ? `request timed out after ${timeoutMs}ms: ${req.url}` : `network error for ${req.url}: ${(err as Error).message}`,
        cause: err,
      });
    }

    if (!res.ok) {
      if (RATE_LIMITED_STATUSES.has(res.status)) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
        throw new UpstreamError({
          exchange: req.exchange,
          kind: 'RATE_LIMITED',
          message: `rate limited: HTTP ${res.status} for ${req.url}`,
          http_status: res.status,
          retry_after_ms: retryAfterMs,
        });
      }
      throw new UpstreamError({
        exchange: req.exchange,
        kind: 'HTTP',
        message: `HTTP ${res.status} for ${req.url}`,
        http_status: res.status,
      });
    }

    let data: T;
    try {
      data = (await res.json()) as T;
    } catch (err) {
      throw new UpstreamError({
        exchange: req.exchange,
        kind: 'PARSE',
        message: `failed to parse JSON from ${req.url}: ${(err as Error).message}`,
        http_status: res.status,
        cause: err,
      });
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      data,
      http_status: res.status,
      headers,
      local_sent: localSent,
      local_received: this.localNow(),
    };
  }
}
