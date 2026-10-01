/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 把 `MarketState`（websocket-data-layer）的記憶體行情轉成 `buildLiveScanCandidates`
 * 需要的 `legData`（market-data-snapshot spec「Research live-scan served from
 * in-memory market state」：請求路徑上 MUST NOT 發出任何上游請求，純讀記憶體）。
 */
import type { MarketState } from '../runtime/src/market/state/marketState';
import type { InstrumentRegistry } from '../runtime/src/market/instruments/registry';
import type { SourceStatusTracker } from '../runtime/src/market/sourceStatus';
import type { ExchangeId } from '../runtime/src/market/instruments/types';
import type { LiveScanLegData } from './liveScanRegistry';

const SCAN_EXCHANGES: ExchangeId[] = ['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'];

export function buildLegDataFromMarketState(registry: InstrumentRegistry, marketState: MarketState): Map<string, LiveScanLegData> {
  const legData = new Map<string, LiveScanLegData>();
  for (const instrument of registry.list()) {
    const ticker = marketState.getTicker(instrument.instrument_id);
    if (ticker === 'NOT_TRACKED') continue;
    if (ticker.funding_rate === null || ticker.mark_price === null) continue;
    legData.set(instrument.instrument_id, {
      rate: ticker.funding_rate,
      mark: ticker.mark_price,
      volume_24h: ticker.volume_24h_quote ?? null,
    });
  }
  return legData;
}

export interface PublicSourceStatus {
  state: string;
  last_success_at: number | null;
  data_age_ms: number | null;
  instrument_count: number;
  consecutive_failures: number;
  rate_limit: { used: number; limit: number; window_ms: number; circuit: string } | null;
}

export function buildSourcesSnapshot(sourceStatus: SourceStatusTracker): Record<ExchangeId, PublicSourceStatus | undefined> {
  const out: Partial<Record<ExchangeId, PublicSourceStatus>> = {};
  for (const exchange of SCAN_EXCHANGES) {
    const status = sourceStatus.get(exchange);
    if (!status) continue;
    out[exchange] = {
      state: status.state,
      last_success_at: status.last_success_at,
      data_age_ms: status.data_age_ms,
      instrument_count: status.instrument_count,
      consecutive_failures: status.consecutive_failures,
      rate_limit: status.rate_limit,
    };
  }
  return out as Record<ExchangeId, PublicSourceStatus | undefined>;
}

export function buildDataAsOf(sourceStatus: SourceStatusTracker): Record<ExchangeId, number | null> {
  const out: Partial<Record<ExchangeId, number | null>> = {};
  for (const exchange of SCAN_EXCHANGES) {
    out[exchange] = sourceStatus.get(exchange)?.last_success_at ?? null;
  }
  return out as Record<ExchangeId, number | null>;
}
