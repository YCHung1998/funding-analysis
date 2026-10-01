/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure live-scan calculations extracted verbatim from server.ts (transitional server layer).
 * No side effects on import: no Express, no Vite, no .env, no fetch.
 */

import type { ExchangeId } from '../runtime/src/types/ids';
import { estimateExpectedNet, type BookQuoteInput, type ExpectedNetConfig } from '../runtime/src/accounting/expectedNet';
import type { SlippageModel } from '../runtime/src/accounting/slippageEngine';

/**
 * Normalizes symbols into standard base symbol (e.g. BTC_USDT_PERP -> BTC, BTC-USDT-SWAP -> BTC, 1000PEPEUSDT -> PEPE)
 */
export function extractBaseSymbol(raw: string): string {
  let s = raw.toUpperCase()
    .replace('-SWAP', '')
    .replace('_PERP', '')
    .replace('_USDT', '')
    .replace('-USDT', '')
    .replace('USDT', '')
    .replace(/[-_]/g, '');

  if (s.startsWith('1000000')) s = s.replace('1000000', '');
  else if (s.startsWith('100000')) s = s.replace('100000', '');
  else if (s.startsWith('10000')) s = s.replace('10000', '');
  else if (s.startsWith('1000')) s = s.replace('1000', '');

  return s;
}

export function findBestPair<E extends string>(rates: Partial<Record<E, number>>, exchanges: readonly E[]): {
  activeExchanges: E[];
  maxSpread: number;
  bestLongEx: E;
  bestShortEx: E;
  pairSpreads: Record<string, number>;
} | null {
      const activeExchanges = exchanges.filter(ex => rates[ex] !== undefined);
      if (activeExchanges.length < 2) return null;

      let maxSpread = 0;
      let bestLongEx: E = activeExchanges[0];
      let bestShortEx: E = activeExchanges[1];

      const pairSpreads: Record<string, number> = {};

      for (let i = 0; i < activeExchanges.length; i++) {
        for (let j = i + 1; j < activeExchanges.length; j++) {
          const exA = activeExchanges[i];
          const exB = activeExchanges[j];
          const rateA = rates[exA]!;
          const rateB = rates[exB]!;
          const spread = Math.abs(rateA - rateB);

          pairSpreads[`${exA}_${exB}`] = spread;

          if (spread > maxSpread) {
            maxSpread = spread;
            if (rateA < rateB) {
              bestLongEx = exA;
              bestShortEx = exB;
            } else {
              bestLongEx = exB;
              bestShortEx = exA;
            }
          }
        }
      }

  return { activeExchanges, maxSpread, bestLongEx, bestShortEx, pairSpreads };
}

export function resolveSettlement(
  nextFundingTimes: Partial<Record<string, number>>,
  intervalsByExchange: Partial<Record<string, number>>,
  now: number,
): { nextFundingTime: number; timeToSettlementSec: number; intervalHours: number } {
      const validTimes = Object.values(nextFundingTimes).filter((t): t is number => typeof t === 'number' && t > now);
      const nextFundingTime = validTimes.length > 0 ? Math.min(...validTimes) : now + 8 * 3600 * 1000;
      const timeToSettlementSec = Math.max(Math.floor((nextFundingTime - now) / 1000), 0);

      const intervals = Object.values(intervalsByExchange).filter((v): v is number => typeof v === 'number');
      const intervalHours = intervals.length > 0 ? Math.min(...intervals) : 8;

  return { nextFundingTime, timeToSettlementSec, intervalHours };
}

/**
 * net-cost-model fix (Q-05[P4]: volume-tier slippage constant; Q-06: fixed 0.20% fee):
 * per-leg "legacy" slippage percentage derived from 24h volume. Research-only transitional
 * input to `estimateExpectedNet`'s `LEGACY_VOLUME_TIER` book-quote kind (design.md Decision 3/9)
 * — kept as the SAME three-tier thresholds as the pre-fix constant so the only change is *where*
 * the number is consumed (cost-model formula) rather than *what* the number is; a real
 * bid/ask-based `TOP_OF_BOOK`/`ORDERBOOK` model is out of scope here (Non-goal: no WebSocket
 * order book subscription in this change).
 */
function legacyVolumeTierSlippagePct(volume24h: number): number {
  return volume24h > 100_000_000 ? 0.00015 : volume24h > 20_000_000 ? 0.0003 : 0.0005;
}

export interface LiveScanNetPnlInput {
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  longRate: number;
  shortRate: number;
  longMark: number;
  shortMark: number;
  longVolume24h: number;
  shortVolume24h: number;
  targetNotionalPerLegUsdt?: number;
  qtyStepLong?: number;
  qtyStepShort?: number;
}

export interface LiveScanNetPnlResult {
  netSpreadPct: number;
  grossSpreadPct: number;
  expectedNetPnlUsdt: number;
  expectedFeesUsdt: number;
  expectedFundingUsdt: number;
  slippageAttributionUsdt: number;
  slippageModel: { long: SlippageModel; short: SlippageModel };
  feeConfigVersion: string;
  entryBasisPct: number;
  meetsThreshold: boolean;
  qualified: boolean;
}

/**
 * Research live-scan 版 Expected Net PnL：改呼叫 `runtime/src/accounting/expectedNet.ts` 的
 * `estimateExpectedNet`（cost-model spec「研究端 live-scan 使用成本模型」），費率取預設費率表、
 * 滑價以 `LEGACY_VOLUME_TIER` 標示（過渡期）。`meetsThreshold = expected_net_pnl_usdt >=
 * researchMinNetPnlUsdt`（預設 0，取代舊的 `maxSpread >= 0.0020` 毛 spread 判定）。
 */
export function computeLiveScanNetPnl(input: LiveScanNetPnlInput, researchMinNetPnlUsdt = 0): LiveScanNetPnlResult {
  const targetNotional = input.targetNotionalPerLegUsdt ?? 1000;
  // 待定：研究端沒有真實 instrument-registry qty_step，暫以 0.0001 近似（細粒度捨去誤差可忽略）。
  const qtyStepLong = input.qtyStepLong ?? 0.0001;
  const qtyStepShort = input.qtyStepShort ?? 0.0001;

  const config: ExpectedNetConfig = {
    slippage_safety_buffer_pct: 0,
    liquidity_assumption: 'TAKER',
    basis_convergence_assumption: 'ADVERSE_ONLY',
    basis_risk_z: 1,
    basis_sigma_pct: 0, // 待定：研究端尚無歷史資料可校準 basis_sigma_pct，暫以 0（不折價）
  };

  const longQuote: BookQuoteInput = {
    kind: 'LEGACY_VOLUME_TIER',
    slippagePct: legacyVolumeTierSlippagePct(input.longVolume24h),
    referencePrice: input.longMark,
  };
  const shortQuote: BookQuoteInput = {
    kind: 'LEGACY_VOLUME_TIER',
    slippagePct: legacyVolumeTierSlippagePct(input.shortVolume24h),
    referencePrice: input.shortMark,
  };

  const result = estimateExpectedNet({
    long: { exchange: input.longExchange, mid_price: input.longMark, mark_price: input.longMark, predicted_rate: input.longRate, quote: longQuote },
    short: { exchange: input.shortExchange, mid_price: input.shortMark, mark_price: input.shortMark, predicted_rate: input.shortRate, quote: shortQuote },
    target_notional_per_leg_usdt: targetNotional,
    qty_step_long: qtyStepLong,
    qty_step_short: qtyStepShort,
    config,
  });

  return {
    netSpreadPct: result.net_spread_pct,
    grossSpreadPct: result.gross_spread_pct,
    expectedNetPnlUsdt: result.expected_net_pnl_usdt,
    expectedFeesUsdt: result.expected_fees_usdt,
    expectedFundingUsdt: result.expected_funding_usdt,
    slippageAttributionUsdt: result.expected_slippage_attribution_usdt,
    slippageModel: result.slippage_model,
    feeConfigVersion: result.fee_config_version,
    entryBasisPct: result.entry_basis_pct,
    meetsThreshold: result.qualified && result.expected_net_pnl_usdt >= researchMinNetPnlUsdt,
    qualified: result.qualified,
  };
}
