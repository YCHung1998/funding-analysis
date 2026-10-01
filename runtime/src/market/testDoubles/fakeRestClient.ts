/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 假 REST client 測試替身：以 (exchange + url) 為 key 排隊回應 / 錯誤，
 * 並計數每個 key 實際被呼叫的次數（供 single-flight 測試驗證）。不連真實網路。
 */
import type { PublicRestClient, RestRequest, RestResult } from '../http/publicRestClient';
import { UpstreamError, type UpstreamErrorKind } from '../http/publicRestClient';

type QueuedResponse<T = unknown> =
  | { kind: 'OK'; data: T; http_status?: number; headers?: Record<string, string> }
  | { kind: 'ERROR'; error: ConstructorParameters<typeof UpstreamError>[0] };

export class FakeRestClient implements PublicRestClient {
  private readonly queues = new Map<string, QueuedResponse[]>();
  private readonly pendingResolvers = new Map<string, Array<(v: QueuedResponse) => void>>();
  readonly callCounts = new Map<string, number>();
  readonly calls: RestRequest[] = [];

  constructor(private readonly localNow: () => number) {}

  private key(req: RestRequest): string {
    return `${req.exchange}:${req.url}`;
  }

  /** 排入下一次對此 key 的回應（依序消費）。 */
  queueResponse<T>(req: Pick<RestRequest, 'exchange' | 'url'>, data: T, opts?: { http_status?: number; headers?: Record<string, string> }): void {
    const k = this.key(req as RestRequest);
    const list = this.queues.get(k) ?? [];
    list.push({ kind: 'OK', data, http_status: opts?.http_status ?? 200, headers: opts?.headers ?? {} });
    this.queues.set(k, list);
  }

  queueError(req: Pick<RestRequest, 'exchange' | 'url'>, error: ConstructorParameters<typeof UpstreamError>[0]): void {
    const k = this.key(req as RestRequest);
    const list = this.queues.get(k) ?? [];
    list.push({ kind: 'ERROR', error });
    this.queues.set(k, list);
  }

  /** 送出一個永遠不會自動 resolve 的呼叫，回傳 resolve 函式供測試手動觸發（single-flight 測試用）。 */
  resolveLatest(req: Pick<RestRequest, 'exchange' | 'url'>, data: unknown): void {
    const k = this.key(req as RestRequest);
    const resolvers = this.pendingResolvers.get(k) ?? [];
    const next = resolvers.shift();
    next?.({ kind: 'OK', data, http_status: 200, headers: {} });
  }

  async getJson<T>(req: RestRequest): Promise<RestResult<T>> {
    const k = this.key(req);
    this.calls.push(req);
    this.callCounts.set(k, (this.callCounts.get(k) ?? 0) + 1);

    const local_sent = this.localNow();
    const queue = this.queues.get(k) ?? [];
    const next = queue.shift();

    let resolved: QueuedResponse;
    if (next) {
      resolved = next;
    } else {
      // 沒有排隊回應時：建立一個手動 resolver，讓測試可延後觸發（模擬慢上游）。
      resolved = await new Promise<QueuedResponse>((resolve) => {
        const list = this.pendingResolvers.get(k) ?? [];
        list.push(resolve);
        this.pendingResolvers.set(k, list);
      });
    }

    const local_received = this.localNow();

    if (resolved.kind === 'ERROR') {
      throw new UpstreamError({ ...resolved.error, exchange: resolved.error.exchange ?? req.exchange });
    }

    return {
      data: resolved.data as T,
      http_status: resolved.http_status ?? 200,
      headers: resolved.headers ?? {},
      local_sent,
      local_received,
    };
  }
}

export function kindIsRetryable(kind: UpstreamErrorKind): boolean {
  return kind === 'TIMEOUT' || kind === 'NETWORK' || kind === 'HTTP';
}
