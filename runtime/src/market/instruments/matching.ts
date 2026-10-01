/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 配對規則（spec「Pair matching rule」、design.md Decision 6）。
 * 不得以交易所名稱做條件分支（Invariant #3，由 noExchangeLiteral.test.ts 守門）。
 */

import type { ContractType, Instrument, PairMatchResult } from './types';

export interface MatchPairOptions {
  now: number;
  funding_alignment_tolerance_ms: number;
  price_mismatch_tolerance_pct: number;
  pairable_contract_types?: ContractType[];
  prices?: { long: number; short: number };
}

const DEFAULT_PAIRABLE_CONTRACT_TYPES: ContractType[] = ['LINEAR_PERPETUAL'];

export function matchPair(long: Instrument, short: Instrument, opts: MatchPairOptions): PairMatchResult {
  const pairableTypes = opts.pairable_contract_types ?? DEFAULT_PAIRABLE_CONTRACT_TYPES;

  // 1. 不同交易所
  if (long.exchange === short.exchange) {
    return { matched: false, reason: 'SAME_EXCHANGE' };
  }

  // 2. 兩腿皆已登錄（呼叫端只傳入已登錄的 Instrument，因此這裡檢查歧義）
  if (long.ambiguous || short.ambiguous) {
    return { matched: false, reason: 'AMBIGUOUS_INSTRUMENT' };
  }

  // 3. instrument_key 相同
  if (long.instrument_key !== short.instrument_key) {
    return { matched: false, reason: 'KEY_MISMATCH' };
  }

  // 4. 合約類型可配對
  if (!pairableTypes.includes(long.contract_type) || !pairableTypes.includes(short.contract_type)) {
    return { matched: false, reason: 'CONTRACT_TYPE_NOT_PAIRABLE' };
  }

  // 5. 兩腿皆交易中
  if (long.status !== 'TRADING' || short.status !== 'TRADING') {
    return { matched: false, reason: 'NOT_TRADING' };
  }

  // 6. 兩腿結算時間皆有效且未過期
  if (
    long.funding.schedule_status !== 'VALID' ||
    short.funding.schedule_status !== 'VALID' ||
    long.funding.next_funding_time === null ||
    short.funding.next_funding_time === null ||
    long.funding.next_funding_time <= opts.now ||
    short.funding.next_funding_time <= opts.now
  ) {
    return { matched: false, reason: 'FUNDING_TIME_MISSING' };
  }

  // 7. 結算時間對齊
  const fundingTimeDiffMs = Math.abs(long.funding.next_funding_time - short.funding.next_funding_time);
  if (fundingTimeDiffMs > opts.funding_alignment_tolerance_ms) {
    return { matched: false, reason: 'FUNDING_NOT_ALIGNED' };
  }

  // 8. 價格守門（選用）
  if (opts.prices) {
    const longNormalized = opts.prices.long / long.price_multiplier;
    const shortNormalized = opts.prices.short / short.price_multiplier;
    const base = Math.max(Math.abs(longNormalized), Math.abs(shortNormalized), Number.EPSILON);
    const relativeDiff = Math.abs(longNormalized - shortNormalized) / base;
    if (relativeDiff > opts.price_mismatch_tolerance_pct) {
      return { matched: false, reason: 'PRICE_MISMATCH' };
    }
  }

  return {
    matched: true,
    instrument_key: long.instrument_key,
    long_instrument_id: long.instrument_id,
    short_instrument_id: short.instrument_id,
    long_funding_time: long.funding.next_funding_time,
    short_funding_time: short.funding.next_funding_time,
    long_funding_interval_hours: long.funding.funding_interval_hours,
    short_funding_interval_hours: short.funding.funding_interval_hours,
    funding_time_diff_ms: fundingTimeDiffMs,
    funding_aligned: true,
  };
}

export interface CandidatePairResult {
  long: Instrument;
  short: Instrument;
  result: PairMatchResult;
}

/** 列舉同一 instrument_key 下所有跨所組合（呼叫端先以 findByKey 篩選）。 */
export function candidatePairs(instruments: Instrument[], opts: MatchPairOptions): CandidatePairResult[] {
  const results: CandidatePairResult[] = [];
  for (let i = 0; i < instruments.length; i++) {
    for (let j = i + 1; j < instruments.length; j++) {
      const a = instruments[i];
      const b = instruments[j];
      if (a.exchange === b.exchange) continue;
      results.push({ long: a, short: b, result: matchPair(a, b, opts) });
    }
  }
  return results;
}
