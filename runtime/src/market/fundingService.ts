/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `fundingService`：把行情資料中的結算時程轉交 `instrument-registry.updateFundingSchedule`
 * （market-data-stream spec「Funding schedule forwarded to the registry」，design.md
 * Decision 1）。`IGNORED_OUT_OF_ORDER` / `UNKNOWN_INSTRUMENT` 不得視為錯誤中斷處理。
 */
import type { InstrumentRegistry } from './instruments/registry';
import type { MarketDataEvent } from './types';

export function forwardFundingSchedule(registry: InstrumentRegistry, event: MarketDataEvent, nativeSymbol: string, now: number): void {
  if (event.next_funding_time === undefined) return;
  registry.updateFundingSchedule(
    event.exchange,
    nativeSymbol,
    { next_funding_time: event.next_funding_time, exchange_timestamp: event.exchange_timestamp },
    now,
  );
  // IGNORED_OUT_OF_ORDER / UNKNOWN_INSTRUMENT 的回傳值刻意不檢查 — 兩者皆非錯誤（spec 明文）。
}
