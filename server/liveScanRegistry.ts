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
import type { SlippageModel } from '../runtime/src/accounting/slippageEngine';
import { computeLiveScanNetPnl, type LiveScanNetPnlResult } from './liveScanMath';

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
  /**
   * [Integrator review fix] Single-leg target notional actually used to compute every *_pct
   * field below (spec §5: `estimated_fee_pct = expected_fees_usdt / target_notional`). All pct
   * fields here are consistently denominated by THIS value, not a separately hardcoded constant.
   */
  target_notional_per_leg_usdt: number;
  /** @deprecated net-cost-model: 以 |slippage_attribution_usdt| / target_notional_per_leg_usdt 計算，顯示用 */
  est_slippage_pct: number;
  /** @deprecated net-cost-model: 改為該配對實際手續費率（兩腿 taker 合計，/ target_notional_per_leg_usdt），不再是固定 0.20% */
  fee_drag_pct: number;
  /** @deprecated net-cost-model: 改為淨值口徑（= net_spread_pct），毛 spread 請見 `spread` 欄位 */
  expected_net_pnl_pct: number;
  /** net-cost-model: 淨值（USDT），取代舊的毛 spread 衍生金額 */
  expected_net_pnl_usdt: number;
  /** net-cost-model: `expected_net_pnl_usdt >= research_min_net_pnl_usdt`（預設 0），不再是毛 spread 判定 */
  meets_threshold: boolean;
  /** net-cost-model spec「以淨 spread 選對、排序與判門檻」：唯一用於選對 / 排序 / 判門檻的欄位 */
  net_spread_pct: number;
  /** 每組配對（`${long}_${short}`）的淨 spread，供前端逐配對顯示 */
  pair_net_spreads: Record<string, number>;
  /** 進場時點兩所中價差（基於 mid，design.md Decision 6） */
  entry_basis_pct: number;
  /** 每腿滑價模型（`LEGACY_VOLUME_TIER`：研究端過渡期，見 Invariant #7） */
  slippage_model: { long: SlippageModel; short: SlippageModel };
  /** 計算本候選時使用的手續費表版本 */
  fee_config_version: string;
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

    // net-cost-model spec「以淨 spread 選對、排序與判門檻」：best pair 依 net_spread_pct 選出，
    // 毛 spread（pairSpreads）僅保留供顯示（`spread` 欄位）。
    const pairSpreads: Record<string, number> = {};
    const pairNetSpreads: Record<string, number> = {};
    let bestNetSpread = -Infinity;
    let bestSpread = -1;
    let bestLongEx: ExchangeId | null = null;
    let bestShortEx: ExchangeId | null = null;
    let bestNetPnl: LiveScanNetPnlResult | null = null;

    for (const { long, short } of matched) {
      const longLeg = legByExchange.get(long.exchange);
      const shortLeg = legByExchange.get(short.exchange);
      if (!longLeg || !shortLeg) continue;
      if (longLeg.data.volume_24h == null || shortLeg.data.volume_24h == null) continue;

      const grossSpread = Math.abs(longLeg.data.rate - shortLeg.data.rate);
      const pairLongEx = longLeg.data.rate < shortLeg.data.rate ? long.exchange : short.exchange;
      const pairShortEx = longLeg.data.rate < shortLeg.data.rate ? short.exchange : long.exchange;
      const pairLongLeg = pairLongEx === long.exchange ? longLeg : shortLeg;
      const pairShortLeg = pairShortEx === long.exchange ? longLeg : shortLeg;

      const pairLabel = `${long.exchange}_${short.exchange}`;
      pairSpreads[pairLabel] = grossSpread;

      const netPnl = computeLiveScanNetPnl({
        longExchange: pairLongEx,
        shortExchange: pairShortEx,
        longRate: pairLongLeg.data.rate,
        shortRate: pairShortLeg.data.rate,
        longMark: pairLongLeg.data.mark,
        shortMark: pairShortLeg.data.mark,
        longVolume24h: pairLongLeg.data.volume_24h!,
        shortVolume24h: pairShortLeg.data.volume_24h!,
      });
      pairNetSpreads[pairLabel] = netPnl.netSpreadPct;

      if (netPnl.netSpreadPct > bestNetSpread) {
        bestNetSpread = netPnl.netSpreadPct;
        bestSpread = grossSpread;
        bestLongEx = pairLongEx;
        bestShortEx = pairShortEx;
        bestNetPnl = netPnl;
      }
    }
    if (bestLongEx === null || bestShortEx === null || bestNetPnl === null) continue;

    const longLeg = legByExchange.get(bestLongEx)!;
    const shortLeg = legByExchange.get(bestShortEx)!;
    const volume24h = Math.min(longLeg.data.volume_24h!, shortLeg.data.volume_24h!);
    const netPnl = bestNetPnl;

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
      long_volume_24h: longLeg.data.volume_24h!,
      short_volume_24h: shortLeg.data.volume_24h!,
      // [Integrator review fix] denominator is the SAME single-leg target notional passed to
      // (and echoed back by) the cost model — not a separately hardcoded `2 * 1000`. Volume is
      // already guaranteed non-null at this point (candidates with a null leg volume were
      // `continue`d above, P3 rule), so there is no "missing data -> silently report 0" branch:
      // whatever the real attribution is, that's what gets divided through.
      target_notional_per_leg_usdt: netPnl.targetNotionalPerLegUsdt,
      est_slippage_pct: Math.abs(netPnl.slippageAttributionUsdt) / netPnl.targetNotionalPerLegUsdt,
      fee_drag_pct: netPnl.expectedFeesUsdt / netPnl.targetNotionalPerLegUsdt,
      expected_net_pnl_pct: netPnl.netSpreadPct,
      expected_net_pnl_usdt: netPnl.expectedNetPnlUsdt,
      meets_threshold: netPnl.meetsThreshold,
      net_spread_pct: netPnl.netSpreadPct,
      pair_net_spreads: pairNetSpreads,
      entry_basis_pct: netPnl.entryBasisPct,
      slippage_model: netPnl.slippageModel,
      fee_config_version: netPnl.feeConfigVersion,
    });
  }

  // net-cost-model spec「以淨 spread 選對、排序與判門檻」：排序依 net_spread_pct（毛 spread 僅顯示）。
  candidates.sort((a, b) => b.net_spread_pct - a.net_spread_pct);
  candidates.forEach((c, idx) => {
    c.rank = idx + 1;
  });
  return candidates;
}
