/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 新鮮度計算（market-data-stream spec「Data freshness measured on the exchange
 * clock」）。純函式，計時由呼叫端（marketState）透過注入的 Clock 取得。
 */
import type { Freshness, MarketDataEvent, MarketDataTier } from '../types';

export interface FreshnessThresholds {
  /** 已入圍合約（SHORTLIST tier）使用的門檻（`data_stale_threshold_ms`）。 */
  shortlist_threshold_ms: number;
  /** 全市場層使用的門檻（`watch_stale_threshold_ms`）。 */
  full_market_threshold_ms: number;
}

export function computeFreshness(params: {
  latest: MarketDataEvent | undefined;
  exchangeNowMs: number;
  tier: MarketDataTier;
  thresholds: FreshnessThresholds;
}): Freshness {
  const { latest, exchangeNowMs, tier, thresholds } = params;
  const threshold_ms = tier === 'SHORTLIST' ? thresholds.shortlist_threshold_ms : thresholds.full_market_threshold_ms;

  if (!latest) {
    return { data_age_ms: null, stale: true, tier, threshold_ms };
  }

  // 入圍層：timestamp_source = 'LOCAL' 一律視為 stale（無法量測就不能拿來交易）。
  if (tier === 'SHORTLIST' && latest.timestamp_source === 'LOCAL') {
    return { data_age_ms: null, stale: true, tier, threshold_ms };
  }

  const data_age_ms = exchangeNowMs - latest.exchange_timestamp;
  return { data_age_ms, stale: data_age_ms > threshold_ms, tier, threshold_ms };
}
