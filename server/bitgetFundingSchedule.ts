/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bitget 資金費時程批次更新（design.md Decision 5：5 分鐘刷新節奏，由
 * GET /api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES 一次取得全部合約，
 * 不逐合約呼叫）。2026-10-01 已實測：不帶 symbol 參數即回傳全部 825 筆合約。
 */

import type { FundingScheduleUpdate } from '../runtime/src/market/instruments/types';

export interface BitgetCurrentFundRateItem {
  symbol: string;
  fundingRate?: string;
  fundingRateInterval?: string;
  nextUpdate?: string;
}

export interface BitgetFundingScheduleEntry {
  native_symbol: string;
  update: FundingScheduleUpdate;
}

export function mapBitgetFundingRateSchedule(
  data: BitgetCurrentFundRateItem[],
  now: number,
): BitgetFundingScheduleEntry[] {
  const entries: BitgetFundingScheduleEntry[] = [];
  for (const item of data) {
    if (!item.symbol || !item.nextUpdate || !item.fundingRateInterval) continue;
    const nextFundingTime = Number(item.nextUpdate);
    const fundingIntervalHours = Number(item.fundingRateInterval);
    if (!Number.isFinite(nextFundingTime) || !Number.isFinite(fundingIntervalHours)) continue;

    entries.push({
      native_symbol: item.symbol,
      update: {
        next_funding_time: nextFundingTime,
        funding_interval_hours: fundingIntervalHours,
        interval_source: 'EXCHANGE_FIELD',
        exchange_timestamp: now,
      },
    });
  }
  return entries;
}
