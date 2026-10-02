/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * cost-model capability: C-13 Net PnL composition and slippage attribution — the ONLY
 * implementations (design.md Decision 4; spec "滑價歸因（僅歸因）", "C-13 淨值組合公式").
 * `composeNetPnl`'s input type intentionally has no slippage field: slippage can only enter
 * Net PnL already baked into `price_pnl` (via actual/estimated fill prices), never as a
 * separate subtraction — this is what fixes Q-05's double-count.
 */

export type OrderSide = 'BUY' | 'SELL';

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${String(value)}`);
  }
}

/**
 * `slippageAttribution = -side_sign * (avg_fill_price - reference_price) * quantity` (BUY
 * side_sign = +1, SELL = -1; negative = cost). Attribution-only: its result MUST NOT be
 * subtracted again inside `composeNetPnl`.
 */
export function slippageAttribution(orderSide: OrderSide, quantity: number, avgFillPrice: number, referencePrice: number): number {
  assertFiniteNumber(quantity, 'quantity');
  assertFiniteNumber(avgFillPrice, 'avgFillPrice');
  assertFiniteNumber(referencePrice, 'referencePrice');
  const sideSign = orderSide === 'BUY' ? 1 : -1;
  return -sideSign * (avgFillPrice - referencePrice) * quantity;
}

export interface NetPnlInput {
  funding_pnl: number;
  price_pnl: number;
  fees: number;
  other_costs: number;
}

/**
 * `Net PnL = funding_pnl + price_pnl - fees - other_costs` (✅ C-13). `price_pnl` MUST already be
 * computed from actual/estimated fill prices (so it already contains slippage) — this function
 * has no slippage parameter by design.
 */
export function composeNetPnl(input: NetPnlInput): number {
  assertFiniteNumber(input.funding_pnl, 'funding_pnl');
  assertFiniteNumber(input.price_pnl, 'price_pnl');
  assertFiniteNumber(input.fees, 'fees');
  assertFiniteNumber(input.other_costs, 'other_costs');
  return input.funding_pnl + input.price_pnl - input.fees - input.other_costs;
}
