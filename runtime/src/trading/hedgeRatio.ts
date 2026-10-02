/**
 * runtime/src/trading/hedgeRatio.ts
 *
 * `position-accounting` capability: hedge ratio computation and
 * classification (position-funding-pnl design.md Decision 4; spec §14,
 * ✅ C-19 2026-10-02 decided basis = `QUANTITY`). Single implementation
 * shared with `paper-execution-engine` (design.md Decision 4 "收斂為單一
 * 實作") — this module does not emit `HEDGE_RATIO_CHANGED` itself; that is
 * the two-leg coordinator's job.
 *
 * Also hosts leg-imbalance measurement (design.md Decision 5): same basis
 * as the hedge ratio, continuous-interval tracking by Fill timestamp.
 */

export type HedgeRatioBasis = 'NOTIONAL' | 'QUANTITY';

/**
 * Pinned shape (CONTRACT_MEMO.md §1 / design.md Decision 4): base-asset
 * quantity (contract multiplier already applied) plus the weighted-average
 * entry price, as carried on `PaperPosition`.
 */
export interface HedgeLegInput {
  base_quantity: number;
  average_entry_price: number;
}

export interface HedgeRatioResult {
  hedge_ratio: number;
  basis: HedgeRatioBasis;
  long_value: number;
  short_value: number;
  /** Always computed under the NOTIONAL basis, regardless of `basis`. */
  notional_ratio: number;
  /** Always computed under the QUANTITY basis, regardless of `basis`. */
  quantity_ratio: number;
  has_exposure: boolean;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${String(value)}`);
  }
}

function notionalValue(leg: HedgeLegInput): number {
  return leg.base_quantity * leg.average_entry_price;
}

function quantityValue(leg: HedgeLegInput): number {
  return leg.base_quantity;
}

/** `min(long_value, short_value) / max(long_value, short_value)`; 0/0 -> 0 (no exposure). */
function ratioOf(longValue: number, shortValue: number): number {
  const max = Math.max(longValue, shortValue);
  if (max <= 0) return 0;
  const min = Math.min(longValue, shortValue);
  return min / max;
}

/**
 * `hedge_ratio = min(long_value, short_value) / max(long_value, short_value)`
 * (design.md Decision 4 / spec §14, ✅ C-19: default basis is `QUANTITY`,
 * i.e. contract-multiplier-converted base-asset quantity, not notional).
 */
export function computeHedgeRatio(long: HedgeLegInput, short: HedgeLegInput, basis: HedgeRatioBasis): HedgeRatioResult {
  assertFiniteNumber(long.base_quantity, 'long.base_quantity');
  assertFiniteNumber(long.average_entry_price, 'long.average_entry_price');
  assertFiniteNumber(short.base_quantity, 'short.base_quantity');
  assertFiniteNumber(short.average_entry_price, 'short.average_entry_price');

  const longNotional = notionalValue(long);
  const shortNotional = notionalValue(short);
  const longQuantity = quantityValue(long);
  const shortQuantity = quantityValue(short);

  const notionalRatio = ratioOf(longNotional, shortNotional);
  const quantityRatio = ratioOf(longQuantity, shortQuantity);

  const longValue = basis === 'NOTIONAL' ? longNotional : longQuantity;
  const shortValue = basis === 'NOTIONAL' ? shortNotional : shortQuantity;
  const hedgeRatio = basis === 'NOTIONAL' ? notionalRatio : quantityRatio;

  return {
    hedge_ratio: hedgeRatio,
    basis,
    long_value: longValue,
    short_value: shortValue,
    notional_ratio: notionalRatio,
    quantity_ratio: quantityRatio,
    has_exposure: longValue > 0 || shortValue > 0,
  };
}

export type HedgeClassification = 'HEDGED' | 'PARTIALLY_HEDGED' | 'LEG_IMBALANCE';

export interface HedgeThreshold {
  hedged_min: number;
  /** Lower bound: `ratio < imbalance_max` -> LEG_IMBALANCE (design.md Decision 4 pinned field name). */
  imbalance_max: number;
}

/** Spec §14 defaults — mirrors `risk/types.ts` `DEFAULT_RISK_CONFIG`'s hedge_ratio_* fields. */
export const DEFAULT_HEDGE_THRESHOLD: HedgeThreshold = { hedged_min: 0.99, imbalance_max: 0.9 };

/**
 * `ratio >= hedged_min` -> HEDGED; `imbalance_max <= ratio < hedged_min` -> PARTIALLY_HEDGED;
 * `ratio < imbalance_max` -> LEG_IMBALANCE (spec §14 table). `overrides` keyed by `symbol`
 * (design.md Decision 4 pinned signature / §14.3 "symbol tier 覆寫").
 */
export function classifyHedge(
  hedge_ratio: number,
  symbol: string,
  overrides?: Record<string, HedgeThreshold>,
): HedgeClassification {
  assertFiniteNumber(hedge_ratio, 'hedge_ratio');
  const threshold = overrides?.[symbol] ?? DEFAULT_HEDGE_THRESHOLD;
  if (hedge_ratio >= threshold.hedged_min) return 'HEDGED';
  if (hedge_ratio >= threshold.imbalance_max) return 'PARTIALLY_HEDGED';
  return 'LEG_IMBALANCE';
}

// ---------------------------------------------------------------------------
// Leg imbalance measurement (design.md Decision 5)
// ---------------------------------------------------------------------------

export interface LegImbalanceState {
  max_leg_imbalance_usdt: number;
  max_leg_imbalance_duration_ms: number;
  /** Internal: start of the currently-open imbalance interval, if any. */
  current_interval_start_ms?: number;
}

export const INITIAL_LEG_IMBALANCE_STATE: LegImbalanceState = {
  max_leg_imbalance_usdt: 0,
  max_leg_imbalance_duration_ms: 0,
};

export interface LegImbalanceSample {
  timestamp: number;
  long: HedgeLegInput;
  short: HedgeLegInput;
  basis: HedgeRatioBasis;
  hedged_min: number;
}

/**
 * Updates the running leg-imbalance measurement after one Fill is applied
 * (design.md Decision 5: "不平衡區間 = hedge_ratio < hedged_min 且任一腿有
 * 部位，以 Fill.timestamp 的連續區間計算最長者"). The USDT amount is always
 * the notional difference between legs (an amount can only be denominated
 * in USDT under the NOTIONAL value, regardless of which `basis` drives
 * classification).
 */
export function updateLegImbalance(state: LegImbalanceState, sample: LegImbalanceSample): LegImbalanceState {
  const { has_exposure, hedge_ratio } = computeHedgeRatio(sample.long, sample.short, sample.basis);
  const longNotional = notionalValue(sample.long);
  const shortNotional = notionalValue(sample.short);
  const imbalanceUsdt = Math.abs(longNotional - shortNotional);
  const maxUsdt = Math.max(state.max_leg_imbalance_usdt, imbalanceUsdt);

  const isImbalanced = has_exposure && hedge_ratio < sample.hedged_min;

  if (isImbalanced) {
    const start = state.current_interval_start_ms ?? sample.timestamp;
    const duration = sample.timestamp - start;
    return {
      max_leg_imbalance_usdt: maxUsdt,
      max_leg_imbalance_duration_ms: Math.max(state.max_leg_imbalance_duration_ms, duration),
      current_interval_start_ms: start,
    };
  }

  if (state.current_interval_start_ms !== undefined) {
    const duration = sample.timestamp - state.current_interval_start_ms;
    return {
      max_leg_imbalance_usdt: maxUsdt,
      max_leg_imbalance_duration_ms: Math.max(state.max_leg_imbalance_duration_ms, duration),
      current_interval_start_ms: undefined,
    };
  }

  return {
    max_leg_imbalance_usdt: maxUsdt,
    max_leg_imbalance_duration_ms: state.max_leg_imbalance_duration_ms,
    current_interval_start_ms: undefined,
  };
}
