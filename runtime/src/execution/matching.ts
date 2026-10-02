/**
 * runtime/src/execution/matching.ts
 *
 * Pure functions: depth walking, slippage, fee, step-size validation
 * (design.md §7 "純函式：walkBook、slippage、fee"; spec "Market order depth
 * walking" / "Partial fills and remainder handling"). No Clock, no I/O, no
 * exchange-name branching — every per-exchange difference arrives as a
 * parameter (rates, levels), never a literal.
 */
import type { OrderBookLevel } from './executionInterface';

export interface LevelFill {
  price: number;
  quantity: number;
}

export interface WalkResult {
  levelFills: LevelFill[];
  filledQuantity: number;
}

/**
 * Consumes `levels` (asks for BUY, bids for SELL) from the best price
 * outward, up to `remainingQty`, optionally bounded by `limitPrice` (LIMIT
 * orders only take levels at-or-better than the limit — spec "LIMIT orders
 * SHALL only consume levels at or better than `requested_price`"). One
 * `LevelFill` per consumed price level (spec §11 "one Order many Fills").
 * Levels are not mutated or re-sorted in place; a sorted copy is used.
 */
export function walkBook(levels: OrderBookLevel[], side: 'BUY' | 'SELL', remainingQty: number, limitPrice?: number): WalkResult {
  const sorted = [...levels].sort((a, b) => (side === 'BUY' ? a.price - b.price : b.price - a.price));
  const eligible = sorted.filter((level) => {
    if (limitPrice === undefined) return true;
    return side === 'BUY' ? level.price <= limitPrice : level.price >= limitPrice;
  });

  const levelFills: LevelFill[] = [];
  let remaining = remainingQty;
  for (const level of eligible) {
    if (remaining <= 0) break;
    const take = Math.min(level.qty, remaining);
    if (take <= 0) continue;
    levelFills.push({ price: level.price, quantity: take });
    remaining -= take;
  }
  const filledQuantity = levelFills.reduce((sum, f) => sum + f.quantity, 0);
  return { levelFills, filledQuantity };
}

/** Quantity-weighted average price across level fills, or `undefined` for an empty set. */
export function averageFillPrice(levelFills: LevelFill[]): number | undefined {
  const totalQty = levelFills.reduce((sum, f) => sum + f.quantity, 0);
  if (totalQty <= 0) return undefined;
  const weighted = levelFills.reduce((sum, f) => sum + f.price * f.quantity, 0);
  return weighted / totalQty;
}

/**
 * `(price - reference) / reference * 100` for BUY, negated for SELL — spec
 * "positive = worse than reference" (a BUY paying more, or a SELL receiving
 * less, than reference is "worse").
 */
export function slippagePct(side: 'BUY' | 'SELL', price: number, referencePrice: number): number {
  const raw = ((price - referencePrice) / referencePrice) * 100;
  return side === 'BUY' ? raw : -raw;
}

export function notionalUsdt(quantity: number, price: number, contractMultiplier: number): number {
  return quantity * price * contractMultiplier;
}

export function feeUsdt(notional: number, feeRate: number): number {
  return notional * feeRate;
}

/**
 * True if `quantity` is a (floating-point-tolerant) multiple of `stepSize`
 * (spec "Quantities SHALL be multiples of the instrument step size").
 */
export function isValidStep(quantity: number, stepSize: number): boolean {
  if (stepSize <= 0) return true;
  const steps = quantity / stepSize;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}
