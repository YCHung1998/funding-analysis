/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 研究端 live-scan 以 Instrument Registry 配對取代 extractBaseSymbol 聚合
 * （openspec/changes/instrument-registry design.md Decision 9、spec「Research server
 * uses the registry during transition」）。純函式，不打真實 API。
 */

import { candidatePairs } from '../runtime/src/market/instruments/matching';
import type { ExchangeId, Instrument } from '../runtime/src/market/instruments/types';
import { computeLiveScanNetPnl } from './liveScanMath';

export interface LiveScanLegData {
  rate: number;
  mark: number;
  volume_24h: number | null;
}

export interface BuildLiveScanCandidatesParams {
  /** instrument_key -> 該 key 下所有交易所的 Instrument（含未取得即時資料者）。 */
  instrumentsByKey: Map<string, Instrument[]>;
  /** instrument_id -> 本次 live-scan 取得的費率 / 標記價 / 24h 量。 */
  legData: Map<string, LiveScanLegData>;
  now: number;
  funding_alignment_tolerance_ms: number;
  price_mismatch_tolerance_pct: number;
  pairable_contract_types?: string[];
}

export interface LiveScanBestPair {
  long_exchange: ExchangeId;
  short_exchange: ExchangeId;
  pair_label: string;
  spread: number;
}

export interface LiveScanCandidate {
  symbol: string;
  base: string;
  instrument_key: string;
  available_exchanges: ExchangeId[];
  pionex_rate: number | null;
  binance_rate: number | null;
  bybit_rate: number | null;
  bitget_rate: number | null;
  okx_rate: number | null;
  pionex_mark: number | null;
  binance_mark: number | null;
  bybit_mark: number | null;
  bitget_mark: number | null;
  okx_mark: number | null;
  spread: number;
  best_pair: LiveScanBestPair;
  pair_spreads: Record<string, number>;
  next_funding_time: number;
  long_funding_time: number;
  short_funding_time: number;
  long_funding_interval_hours: number | null;
  short_funding_interval_hours: number | null;
  funding_aligned: boolean;
  time_to_settlement_sec: number;
  interval_hours: number;
  volume_24h: number;
  long_volume_24h: number;
  short_volume_24h: number;
  est_slippage_pct: number;
  fee_drag_pct: number;
  expected_net_pnl_pct: number;
  expected_net_pnl_usdt: number;
  meets_threshold: boolean;
  rank?: number;
}

export function buildLiveScanCandidates(params: BuildLiveScanCandidatesParams): LiveScanCandidate[] {
  const candidates: LiveScanCandidate[] = [];

  for (const [key, instruments] of params.instrumentsByKey) {
    const tradable = instruments.filter(
      (i) => i.status === 'TRADING' && !i.ambiguous && i.contract_type === 'LINEAR_PERPETUAL',
    );
    if (tradable.length < 2) continue;

    const matched = candidatePairs(tradable, {
      now: params.now,
      funding_alignment_tolerance_ms: params.funding_alignment_tolerance_ms,
      price_mismatch_tolerance_pct: params.price_mismatch_tolerance_pct,
      pairable_contract_types: params.pairable_contract_types as Instrument['contract_type'][] | undefined,
    }).filter((p) => p.result.matched);
    if (matched.length === 0) continue;

    const legByExchange = new Map<ExchangeId, { instrument: Instrument; data: LiveScanLegData }>();
    for (const instrument of tradable) {
      const data = params.legData.get(instrument.instrument_id);
      if (data) legByExchange.set(instrument.exchange, { instrument, data });
    }
    if (legByExchange.size < 2) continue;

    const pairSpreads: Record<string, number> = {};
    let bestSpread = -1;
    let bestLongEx: ExchangeId | null = null;
    let bestShortEx: ExchangeId | null = null;

    for (const { long, short } of matched) {
      const longLeg = legByExchange.get(long.exchange);
      const shortLeg = legByExchange.get(short.exchange);
      if (!longLeg || !shortLeg) continue;
      const spread = Math.abs(longLeg.data.rate - shortLeg.data.rate);
      pairSpreads[`${long.exchange}_${short.exchange}`] = spread;
      if (spread > bestSpread) {
        bestSpread = spread;
        if (longLeg.data.rate < shortLeg.data.rate) {
          bestLongEx = long.exchange;
          bestShortEx = short.exchange;
        } else {
          bestLongEx = short.exchange;
          bestShortEx = long.exchange;
        }
      }
    }
    if (bestLongEx === null || bestShortEx === null) continue;

    const longLeg = legByExchange.get(bestLongEx)!;
    const shortLeg = legByExchange.get(bestShortEx)!;

    // 缺量淘汰（移除 `|| 10000000` 預設）
    if (longLeg.data.volume_24h == null || shortLeg.data.volume_24h == null) continue;

    const volume24h = Math.min(longLeg.data.volume_24h, shortLeg.data.volume_24h);
    const netPnl = computeLiveScanNetPnl(bestSpread, volume24h);

    const rates: Partial<Record<ExchangeId, number>> = {};
    const marks: Partial<Record<ExchangeId, number>> = {};
    for (const [exchange, leg] of legByExchange) {
      rates[exchange] = leg.data.rate;
      marks[exchange] = leg.data.mark;
    }

    const longFundingTime = longLeg.instrument.funding.next_funding_time ?? params.now;

    candidates.push({
      symbol: `${tradable[0].base_asset}${tradable[0].quote_asset}`,
      base: tradable[0].base_asset,
      instrument_key: key,
      available_exchanges: [...legByExchange.keys()],
      pionex_rate: rates.Pionex ?? null,
      binance_rate: rates.Binance ?? null,
      bybit_rate: rates.Bybit ?? null,
      bitget_rate: rates.Bitget ?? null,
      okx_rate: rates.OKX ?? null,
      pionex_mark: marks.Pionex ?? null,
      binance_mark: marks.Binance ?? null,
      bybit_mark: marks.Bybit ?? null,
      bitget_mark: marks.Bitget ?? null,
      okx_mark: marks.OKX ?? null,
      spread: bestSpread,
      best_pair: {
        long_exchange: bestLongEx,
        short_exchange: bestShortEx,
        pair_label: `Long ${bestLongEx} / Short ${bestShortEx}`,
        spread: bestSpread,
      },
      pair_spreads: pairSpreads,
      next_funding_time: longFundingTime,
      long_funding_time: longFundingTime,
      short_funding_time: shortLeg.instrument.funding.next_funding_time ?? params.now,
      long_funding_interval_hours: longLeg.instrument.funding.funding_interval_hours,
      short_funding_interval_hours: shortLeg.instrument.funding.funding_interval_hours,
      funding_aligned: true,
      time_to_settlement_sec: Math.max(Math.floor((longFundingTime - params.now) / 1000), 0),
      interval_hours: longLeg.instrument.funding.funding_interval_hours ?? shortLeg.instrument.funding.funding_interval_hours ?? 8,
      volume_24h: volume24h,
      long_volume_24h: longLeg.data.volume_24h,
      short_volume_24h: shortLeg.data.volume_24h,
      est_slippage_pct: netPnl.estSlippagePct,
      fee_drag_pct: netPnl.feeDragPct,
      expected_net_pnl_pct: netPnl.expectedNetPnlPct,
      expected_net_pnl_usdt: netPnl.expectedNetPnlUsdt,
      meets_threshold: netPnl.meetsThreshold,
    });
  }

  candidates.sort((a, b) => b.spread - a.spread);
  candidates.forEach((c, idx) => {
    c.rank = idx + 1;
  });
  return candidates;
}
