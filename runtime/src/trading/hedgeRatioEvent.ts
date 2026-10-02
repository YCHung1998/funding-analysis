/**
 * runtime/src/trading/hedgeRatioEvent.ts
 *
 * `paper-execution-engine` task 3.1 — wires the two-leg coordinators to
 * `position-accounting`'s `computeHedgeRatio`/`classifyHedge`
 * (`runtime/src/trading/hedgeRatio.ts`, the real implementation merged by
 * `position-funding-pnl`; this module does NOT reimplement the formula,
 * design.md Decision 5). Adds the switchable-basis config shape
 * (`hedge_ratio_basis`, `symbol_tier_overrides`) and the
 * `HEDGE_RATIO_CHANGED` event builder (spec "Hedge ratio behaviour with
 * switchable basis").
 */
import type { EventClock, TradingEvent } from '../types/event';
import {
  classifyHedge,
  computeHedgeRatio,
  DEFAULT_HEDGE_THRESHOLD,
  type HedgeClassification,
  type HedgeLegInput,
  type HedgeRatioBasis,
  type HedgeRatioResult,
  type HedgeThreshold,
} from './hedgeRatio';

export type { HedgeRatioBasis, HedgeThreshold };

/** ✅ C-19 (2026-10-02): default basis is `QUANTITY`, not the spec.md-literal `NOTIONAL`. */
export const DEFAULT_HEDGE_RATIO_BASIS: HedgeRatioBasis = 'QUANTITY';

export interface HedgeRatioConfig {
  /** Default `DEFAULT_HEDGE_RATIO_BASIS` ('QUANTITY', ✅ C-19) when omitted. */
  hedge_ratio_basis?: HedgeRatioBasis;
  /** Default `DEFAULT_HEDGE_THRESHOLD.hedged_min` (0.99) when omitted. */
  hedge_ratio_hedged_min?: number;
  /** Default `DEFAULT_HEDGE_THRESHOLD.imbalance_max` (0.90) when omitted. */
  hedge_ratio_imbalance_below?: number;
  /** Per-symbol threshold overrides (spec §14.3 "symbol tier 覆寫"). */
  symbol_tier_overrides?: Record<string, HedgeThreshold>;
}

/** Resolves the effective threshold for `symbol`: tier override, else config defaults, else spec defaults. */
export function resolveHedgeThreshold(symbol: string, config: HedgeRatioConfig): HedgeThreshold {
  if (config.symbol_tier_overrides?.[symbol]) return config.symbol_tier_overrides[symbol];
  return {
    hedged_min: config.hedge_ratio_hedged_min ?? DEFAULT_HEDGE_THRESHOLD.hedged_min,
    imbalance_max: config.hedge_ratio_imbalance_below ?? DEFAULT_HEDGE_THRESHOLD.imbalance_max,
  };
}

export interface HedgeRatioEvaluation {
  classification: HedgeClassification;
  result: HedgeRatioResult;
  threshold: HedgeThreshold;
  basis: HedgeRatioBasis;
}

/**
 * Evaluates the current hedge ratio for a trade's long/short legs under the
 * configured (switchable) basis, and classifies it via `classifyHedge` —
 * the single shared implementation (design.md Decision 5 "收斂為單一實作").
 */
export function evaluateHedgeRatio(params: {
  symbol: string;
  long: HedgeLegInput;
  short: HedgeLegInput;
  config: HedgeRatioConfig;
}): HedgeRatioEvaluation {
  const basis = params.config.hedge_ratio_basis ?? DEFAULT_HEDGE_RATIO_BASIS;
  const threshold = resolveHedgeThreshold(params.symbol, params.config);
  const result = computeHedgeRatio(params.long, params.short, basis);
  const classification = classifyHedge(result.hedge_ratio, params.symbol, {
    [params.symbol]: threshold,
  });
  return { classification, result, threshold, basis };
}

/**
 * Builds the `HEDGE_RATIO_CHANGED` event (spec: "the coordinator SHALL emit
 * `HEDGE_RATIO_CHANGED` with `ratio`, `basis`, `notional_ratio`,
 * `quantity_ratio`, `long_value`, `short_value`" — both ratios are always
 * recorded regardless of the selected basis, for comparison).
 */
export function buildHedgeRatioChangedEvent(
  params: { trade_id: string; symbol: string; result: HedgeRatioResult },
  clock: EventClock,
): TradingEvent {
  const timestamp = clock.now();
  return {
    event_id: crypto.randomUUID(),
    event_type: 'HEDGE_RATIO_CHANGED',
    timestamp,
    trade_id: params.trade_id,
    symbol: params.symbol,
    payload: {
      ratio: params.result.hedge_ratio,
      basis: params.result.basis,
      notional_ratio: params.result.notional_ratio,
      quantity_ratio: params.result.quantity_ratio,
      long_value: params.result.long_value,
      short_value: params.result.short_value,
    },
    recorded_at: timestamp,
  };
}
