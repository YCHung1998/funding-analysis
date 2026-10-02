/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * cost-model capability: funding cashflow amount (design.md Decision 5; spec "資金費金額以
 * mark price × 數量計算"). This is a thin, keyword-argument wrapper around
 * `funding-settlement-rules`'s `computeSettlementCashflow` — the formula is NOT forked; both the
 * "已結算" amount (funding-settlement-rules / position-funding-pnl) and the "預期" amount (this
 * capability) MUST use the same underlying function (Q-07).
 */

import { computeSettlementCashflow, type PositionSide } from '../funding/settlementInference';

export type { PositionSide };

export interface FundingCashflowInput {
  side: PositionSide;
  /** Base-asset quantity (contract multiplier already applied), not a fixed notional. */
  baseQuantity: number;
  markPrice: number;
  rate: number;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${String(value)}`);
  }
}

/**
 * `cashflow = -side_sign * base_quantity * mark_price * rate` (LONG side_sign = +1, SHORT = -1;
 * positive rate: LONG pays, SHORT receives). `base_quantity` MUST be the base-asset quantity, not
 * a fixed nominal.
 */
export function fundingCashflow(input: FundingCashflowInput): number {
  assertFiniteNumber(input.baseQuantity, 'baseQuantity');
  assertFiniteNumber(input.markPrice, 'markPrice');
  assertFiniteNumber(input.rate, 'rate');
  return computeSettlementCashflow({
    side: input.side,
    quantity: input.baseQuantity,
    settledRate: input.rate,
    markPrice: input.markPrice,
  });
}
