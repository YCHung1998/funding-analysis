/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `queryServerTime`（market-data-snapshot spec「Exchange server time query for
 * trading-clock」）：經 GuardedRestClient（計入限流、斷路器）但 MUST NOT
 * single-flight（每次樣本需要自己的往返時間）。偏差 / 誤差計算屬 trading-clock，
 * 本檔只提供樣本。
 */
import type { ExchangeId } from '../types/ids';
import type { GuardedRestClient } from './http/guardedRestClient';
import type { MarketDataAdapter, ServerTimeSample } from './types';

export async function queryServerTime(
  client: GuardedRestClient,
  adapter: Pick<MarketDataAdapter, 'exchange' | 'serverTime'>,
): Promise<ServerTimeSample> {
  const req = adapter.serverTime.request();
  const result = await client.getJsonNoCoalesce<unknown>(req);
  const server_time = adapter.serverTime.parse(result.data);
  return {
    exchange: adapter.exchange,
    server_time,
    local_sent: result.local_sent,
    local_received: result.local_received,
  };
}

/**
 * `trading-clock` 跨 change 假設 B2：`RealClock` 接受一個
 * `ServerTimeSource.query(ex): Promise<ServerTimeSample>`。本轉接層把 `queryServerTime`
 * 包成該介面，`localNow` 不使用（GuardedRestClient 已用注入的 Clock）。
 */
export interface ServerTimeSource {
  query(ex: ExchangeId): Promise<{ server_time: number; local_sent: number; local_received: number }>;
}

export function makeServerTimeSource(client: GuardedRestClient, adapters: Record<ExchangeId, Pick<MarketDataAdapter, 'exchange' | 'serverTime'>>): ServerTimeSource {
  return {
    async query(ex: ExchangeId) {
      const adapter = adapters[ex];
      return queryServerTime(client, adapter);
    },
  };
}
