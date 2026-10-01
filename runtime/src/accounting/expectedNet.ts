/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * cost-model capability: Expected Net PnL, net-spread selection/ranking/threshold, and predicted
 * -rate risk re-evaluation (design.md Decisions 6-8; spec "Expected Net PnL（預期淨利）",
 * "以淨 spread 選對、排序與判門檻", "預測費率風險重算").
 */

import type { ExchangeId } from '../types/ids';
import { DEFAULT_FEE_TABLE, type FeeTierConfig } from './feeConfig';
import { estimateFee, type Liquidity } from './feeEngine';
import { fundingCashflow, type PositionSide } from './fundingMath';
import { composeNetPnl, slippageAttribution } from './pnlFormula';
import { topOfBook, walkBook, withBuffer, type OrderBook, type Side, type SlippageModel } from './slippageEngine';

export const COST_MODEL_VERSION = 'net-cost-model/v1';

export type BasisConvergenceAssumption = 'NONE' | 'ADVERSE_ONLY' | 'FULL';

export type BookQuoteInput =
  | ({ kind: 'ORDERBOOK' } & OrderBook)
  | { kind: 'TOP_OF_BOOK'; bestBid: number; bestAsk: number }
  /** Research `server/liveScanMath.ts` transitional path only (design.md Decision 3/9). */
  | { kind: 'LEGACY_VOLUME_TIER'; slippagePct: number; referencePrice: number }
  | { kind: 'UNAVAILABLE' };

export interface ExpectedNetLegInput {
  exchange: ExchangeId;
  mid_price: number;
  mark_price: number;
  mark_price_source?: string;
  predicted_rate: number;
  quote: BookQuoteInput;
}

export interface ExpectedNetConfig {
  /** 待定：design.md Open Question 3 — 1bp 預設值待 Paper 期間校準。 */
  slippage_safety_buffer_pct: number;
  liquidity_assumption: Liquidity;
  basis_convergence_assumption: BasisConvergenceAssumption;
  basis_risk_z: number;
  /** 待定：design.md Open Question 2 — 0.0005 為暫定值，缺乏實證，需以 B7 歷史窗口資料校準。 */
  basis_sigma_pct: number;
  fee_table?: readonly FeeTierConfig[];
}

export interface ExpectedNetInput {
  long: ExpectedNetLegInput;
  short: ExpectedNetLegInput;
  target_notional_per_leg_usdt: number;
  qty_step_long: number;
  qty_step_short: number;
  config: ExpectedNetConfig;
}

export type ExpectedNetReason = 'SLIPPAGE_UNAVAILABLE' | 'INSUFFICIENT_DEPTH';

export interface ExpectedNetResult {
  qualified: boolean;
  reason?: ExpectedNetReason;
  quantity_long: number;
  quantity_short: number;
  expected_funding_usdt: number;
  expected_fees_usdt: number;
  expected_slippage_attribution_usdt: number;
  entry_basis_pct: number;
  expected_basis_pnl_usdt: number;
  expected_price_pnl_usdt: number;
  basis_risk_charge_usdt: number;
  expected_net_pnl_usdt: number;
  net_spread_pct: number;
  gross_spread_pct: number;
  fee_config_version: string;
  cost_model_version: string;
  slippage_model: { long: SlippageModel; short: SlippageModel };
  mark_price_source: { long?: string; short?: string };
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${String(value)}`);
  }
}

function decimalsOf(step: number): number {
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dotIndex = s.indexOf('.');
  return dotIndex === -1 ? 0 : s.length - dotIndex - 1;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Floors `value` down to the nearest multiple of `step` (decimal-safe). */
function floorToStep(value: number, step: number): number {
  assertFiniteNumber(value, 'value');
  assertFiniteNumber(step, 'step');
  if (step <= 0) throw new TypeError(`step must be positive, got ${step}`);
  const steps = Math.floor(value / step + 1e-9);
  return roundToDecimals(steps * step, decimalsOf(step));
}

interface ResolvedFillSlippage {
  model: SlippageModel;
  attribution: number;
  depthSufficient: boolean;
}

/** Resolves one fill's buffered slippage attribution from a `BookQuoteInput`. */
function resolveFillSlippage(side: Side, quantity: number, quote: BookQuoteInput, bufferPct: number): ResolvedFillSlippage {
  if (quote.kind === 'UNAVAILABLE') {
    return { model: 'UNAVAILABLE', attribution: NaN, depthSufficient: false };
  }

  if (quote.kind === 'ORDERBOOK') {
    const walked = walkBook(side, quantity, quote);
    if (!walked.depth_sufficient) {
      return { model: 'ORDERBOOK', attribution: NaN, depthSufficient: false };
    }
    const buffered = withBuffer(walked, bufferPct, quantity);
    const rawAttribution = slippageAttribution(side, quantity, walked.expected_avg_price, walked.reference_price);
    const bufferCost = bufferPct * walked.reference_price * quantity;
    return { model: 'ORDERBOOK', attribution: rawAttribution - bufferCost, depthSufficient: true };
  }

  if (quote.kind === 'TOP_OF_BOOK') {
    const top = topOfBook(side, quantity, quote);
    const rawAttribution = slippageAttribution(side, quantity, top.expected_avg_price, top.reference_price);
    const bufferCost = bufferPct * top.reference_price * quantity;
    return { model: 'TOP_OF_BOOK', attribution: rawAttribution - bufferCost, depthSufficient: true };
  }

  // LEGACY_VOLUME_TIER: research transitional path only (design.md Decision 3/9).
  assertFiniteNumber(quote.slippagePct, 'quote.slippagePct');
  assertFiniteNumber(quote.referencePrice, 'quote.referencePrice');
  const bufferCost = bufferPct * quote.referencePrice * quantity;
  const baseCost = quote.slippagePct * quote.referencePrice * quantity;
  return { model: 'LEGACY_VOLUME_TIER', attribution: -(baseCost + bufferCost), depthSufficient: true };
}

interface LegSlippageOutcome {
  model: SlippageModel;
  attribution: number;
  reason?: ExpectedNetReason;
}

/** Entry + exit (closing side as proxy, same book snapshot — design.md Decision 3 "出場滑價"). */
function legSlippage(positionSide: PositionSide, quantity: number, quote: BookQuoteInput, bufferPct: number): LegSlippageOutcome {
  const entrySide: Side = positionSide === 'LONG' ? 'BUY' : 'SELL';
  const exitSide: Side = positionSide === 'LONG' ? 'SELL' : 'BUY';
  const entry = resolveFillSlippage(entrySide, quantity, quote, bufferPct);
  const exit = resolveFillSlippage(exitSide, quantity, quote, bufferPct);

  if (entry.model === 'UNAVAILABLE' || exit.model === 'UNAVAILABLE') {
    return { model: 'UNAVAILABLE', attribution: NaN, reason: 'SLIPPAGE_UNAVAILABLE' };
  }
  if (!entry.depthSufficient || !exit.depthSufficient) {
    return { model: entry.model, attribution: NaN, reason: 'INSUFFICIENT_DEPTH' };
  }
  return { model: entry.model, attribution: entry.attribution + exit.attribution };
}

function assertLegInput(leg: ExpectedNetLegInput, label: string): void {
  assertFiniteNumber(leg.mid_price, `${label}.mid_price`);
  assertFiniteNumber(leg.mark_price, `${label}.mark_price`);
  assertFiniteNumber(leg.predicted_rate, `${label}.predicted_rate`);
}

/**
 * Computes the full Expected Net PnL breakdown for one long/short pair (spec "Expected Net PnL
 * （預期淨利）"). Slippage appears exactly once, inside `expected_price_pnl_usdt`.
 */
export function estimateExpectedNet(input: ExpectedNetInput): ExpectedNetResult {
  assertFiniteNumber(input.target_notional_per_leg_usdt, 'target_notional_per_leg_usdt');
  if (input.target_notional_per_leg_usdt <= 0) {
    throw new TypeError(`target_notional_per_leg_usdt must be positive, got ${input.target_notional_per_leg_usdt}`);
  }
  assertLegInput(input.long, 'long');
  assertLegInput(input.short, 'short');
  assertFiniteNumber(input.config.slippage_safety_buffer_pct, 'config.slippage_safety_buffer_pct');
  assertFiniteNumber(input.config.basis_risk_z, 'config.basis_risk_z');
  assertFiniteNumber(input.config.basis_sigma_pct, 'config.basis_sigma_pct');

  const feeTable = input.config.fee_table ?? DEFAULT_FEE_TABLE;
  const liquidity = input.config.liquidity_assumption;

  const quantityLong = floorToStep(input.target_notional_per_leg_usdt / input.long.mid_price, input.qty_step_long);
  const quantityShort = floorToStep(input.target_notional_per_leg_usdt / input.short.mid_price, input.qty_step_short);

  const fundingLong = fundingCashflow({ side: 'LONG', baseQuantity: quantityLong, markPrice: input.long.mark_price, rate: input.long.predicted_rate });
  const fundingShort = fundingCashflow({ side: 'SHORT', baseQuantity: quantityShort, markPrice: input.short.mark_price, rate: input.short.predicted_rate });
  const expectedFundingUsdt = fundingLong + fundingShort;

  const feesLong = estimateFee(input.long.exchange, input.target_notional_per_leg_usdt, liquidity, feeTable);
  const feesShort = estimateFee(input.short.exchange, input.target_notional_per_leg_usdt, liquidity, feeTable);
  // 4 fills: long entry+exit, short entry+exit.
  const expectedFeesUsdt = feesLong.fee_usdt * 2 + feesShort.fee_usdt * 2;

  const slipLong = legSlippage('LONG', quantityLong, input.long.quote, input.config.slippage_safety_buffer_pct);
  const slipShort = legSlippage('SHORT', quantityShort, input.short.quote, input.config.slippage_safety_buffer_pct);

  const slippageModel = { long: slipLong.model, short: slipShort.model };
  const feeConfigVersion = feesLong.fee_config_version;

  const grossSpreadPct = input.short.predicted_rate - input.long.predicted_rate;

  if (slipLong.reason || slipShort.reason) {
    const reason: ExpectedNetReason = slipLong.reason === 'SLIPPAGE_UNAVAILABLE' || slipShort.reason === 'SLIPPAGE_UNAVAILABLE'
      ? 'SLIPPAGE_UNAVAILABLE'
      : 'INSUFFICIENT_DEPTH';
    return {
      qualified: false,
      reason,
      quantity_long: quantityLong,
      quantity_short: quantityShort,
      expected_funding_usdt: expectedFundingUsdt,
      expected_fees_usdt: expectedFeesUsdt,
      expected_slippage_attribution_usdt: NaN,
      entry_basis_pct: NaN,
      expected_basis_pnl_usdt: NaN,
      expected_price_pnl_usdt: NaN,
      basis_risk_charge_usdt: NaN,
      expected_net_pnl_usdt: NaN,
      net_spread_pct: NaN,
      gross_spread_pct: grossSpreadPct,
      fee_config_version: feeConfigVersion,
      cost_model_version: COST_MODEL_VERSION,
      slippage_model: slippageModel,
      mark_price_source: { long: input.long.mark_price_source, short: input.short.mark_price_source },
    };
  }

  const expectedSlippageAttributionUsdt = slipLong.attribution + slipShort.attribution;

  const entryBasisPct = (input.short.mid_price - input.long.mid_price) / input.long.mid_price;
  const basisAssumption = input.config.basis_convergence_assumption;
  const expectedBasisPnlUsdt =
    basisAssumption === 'NONE'
      ? 0
      : basisAssumption === 'FULL'
        ? entryBasisPct * input.target_notional_per_leg_usdt
        : Math.min(0, entryBasisPct) * input.target_notional_per_leg_usdt; // ADVERSE_ONLY

  const expectedPricePnlUsdt = expectedBasisPnlUsdt + expectedSlippageAttributionUsdt;
  const basisRiskChargeUsdt = input.config.basis_risk_z * input.config.basis_sigma_pct * input.target_notional_per_leg_usdt;

  const expectedNetPnlUsdt = composeNetPnl({
    funding_pnl: expectedFundingUsdt,
    price_pnl: expectedPricePnlUsdt,
    fees: expectedFeesUsdt,
    other_costs: basisRiskChargeUsdt,
  });

  const netSpreadPct = expectedNetPnlUsdt / input.target_notional_per_leg_usdt;

  return {
    qualified: true,
    quantity_long: quantityLong,
    quantity_short: quantityShort,
    expected_funding_usdt: expectedFundingUsdt,
    expected_fees_usdt: expectedFeesUsdt,
    expected_slippage_attribution_usdt: expectedSlippageAttributionUsdt,
    entry_basis_pct: entryBasisPct,
    expected_basis_pnl_usdt: expectedBasisPnlUsdt,
    expected_price_pnl_usdt: expectedPricePnlUsdt,
    basis_risk_charge_usdt: basisRiskChargeUsdt,
    expected_net_pnl_usdt: expectedNetPnlUsdt,
    net_spread_pct: netSpreadPct,
    gross_spread_pct: grossSpreadPct,
    fee_config_version: feeConfigVersion,
    cost_model_version: COST_MODEL_VERSION,
    slippage_model: slippageModel,
    mark_price_source: { long: input.long.mark_price_source, short: input.short.mark_price_source },
  };
}

/** `net_spread_pct = expected_net_pnl_usdt / target_notional_per_leg_usdt` (already on the result, exported standalone for other callers). */
export function netSpread(result: { expected_net_pnl_usdt: number }, targetNotionalPerLegUsdt: number): number {
  assertFiniteNumber(targetNotionalPerLegUsdt, 'targetNotionalPerLegUsdt');
  if (targetNotionalPerLegUsdt <= 0) throw new TypeError(`targetNotionalPerLegUsdt must be positive, got ${targetNotionalPerLegUsdt}`);
  return result.expected_net_pnl_usdt / targetNotionalPerLegUsdt;
}

export interface NetThresholdConfig {
  minimum_expected_net_pnl_usdt: number;
  minimum_net_spread_pct: number;
}

export type NetThresholdReason = 'BELOW_MIN_NET_PNL' | 'BELOW_MIN_NET_SPREAD';

/**
 * Qualification gate (spec "以淨 spread 選對、排序與判門檻"):
 * `expected_net_pnl_usdt >= minimum_expected_net_pnl_usdt AND net_spread_pct >= minimum_net_spread_pct`.
 */
export function meetsNetThreshold(
  result: { expected_net_pnl_usdt: number; net_spread_pct: number },
  config: NetThresholdConfig,
): { qualified: boolean; reason?: NetThresholdReason } {
  if (result.expected_net_pnl_usdt < config.minimum_expected_net_pnl_usdt) return { qualified: false, reason: 'BELOW_MIN_NET_PNL' };
  if (result.net_spread_pct < config.minimum_net_spread_pct) return { qualified: false, reason: 'BELOW_MIN_NET_SPREAD' };
  return { qualified: true };
}

/** Picks the candidate with the largest `net_spread_pct` from one symbol's pairs (spec "Best pair 依淨值"). */
export function selectBestPair<T extends { result: { net_spread_pct: number } }>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => (candidate.result.net_spread_pct > best.result.net_spread_pct ? candidate : best));
}

/**
 * Sorts by `net_spread_pct` desc, tie-break `expected_net_pnl_usdt` desc, final tie-break by
 * `symbol` asc (determinism).
 */
export function rankByNet<T extends { symbol?: string; result: { net_spread_pct: number; expected_net_pnl_usdt: number } }>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((a, b) => {
    if (b.result.net_spread_pct !== a.result.net_spread_pct) return b.result.net_spread_pct - a.result.net_spread_pct;
    if (b.result.expected_net_pnl_usdt !== a.result.expected_net_pnl_usdt) return b.result.expected_net_pnl_usdt - a.result.expected_net_pnl_usdt;
    return (a.symbol ?? '').localeCompare(b.symbol ?? '');
  });
}

export type PredictedRateRiskResult = 'OK' | 'SPREAD_FLIPPED' | 'BELOW_MIN_NET_PNL';

/**
 * Recomputes Expected Net PnL with the latest predicted rates/quotes (spec "預測費率風險重算").
 * Direction check (sign of short_rate - long_rate flipping) takes priority over the net-pnl
 * threshold. Pure: does not read the clock; ARM scheduling is `paper-trading-event-loop`'s job.
 */
export function evaluatePredictedRateRisk(
  evaluated: ExpectedNetInput,
  latest: ExpectedNetInput,
  config: { minimum_expected_net_pnl_usdt: number },
): { result: PredictedRateRiskResult; recomputed: ExpectedNetResult } {
  const evaluatedSign = Math.sign(evaluated.short.predicted_rate - evaluated.long.predicted_rate);
  const latestSign = Math.sign(latest.short.predicted_rate - latest.long.predicted_rate);
  const recomputed = estimateExpectedNet(latest);

  if (evaluatedSign !== 0 && latestSign !== 0 && evaluatedSign !== latestSign) {
    return { result: 'SPREAD_FLIPPED', recomputed };
  }
  if (recomputed.expected_net_pnl_usdt < config.minimum_expected_net_pnl_usdt) {
    return { result: 'BELOW_MIN_NET_PNL', recomputed };
  }
  return { result: 'OK', recomputed };
}
