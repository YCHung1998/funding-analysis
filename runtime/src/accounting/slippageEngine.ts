/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * cost-model capability: Slippage Engine (design.md Decision 3; spec "盤口深度逐檔吃單滑價",
 * "可設定的 safety buffer", "無完整盤口時的退回模型"). Walk-the-book + safety buffer + explicit
 * fallback models — never a volume-tier constant outside the research transitional path.
 */

export type Side = 'BUY' | 'SELL';
export type SlippageModel = 'ORDERBOOK' | 'TOP_OF_BOOK' | 'LEGACY_VOLUME_TIER' | 'UNAVAILABLE';

export interface BookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface WalkBookResult {
  model: 'ORDERBOOK';
  expected_avg_price: number;
  reference_price: number;
  expected_slippage_pct: number;
  expected_slippage_usdt: number;
  fillable_quantity: number;
  depth_sufficient: boolean;
  reason?: 'INSUFFICIENT_DEPTH';
}

export interface TopOfBookResult {
  model: 'TOP_OF_BOOK';
  expected_avg_price: number;
  reference_price: number;
  expected_slippage_pct: number;
  expected_slippage_usdt: number;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${String(value)}`);
  }
}

/**
 * Walk-the-book: BUY consumes asks low-to-high, SELL consumes bids high-to-low, until `quantity`
 * base units are filled. `reference_price = (best_bid + best_ask) / 2`. Throws if the book has no
 * bid/ask at all — callers without a full book MUST use `topOfBook` or treat the leg as
 * `UNAVAILABLE` instead.
 */
export function walkBook(side: Side, quantity: number, book: OrderBook): WalkBookResult {
  assertFiniteNumber(quantity, 'quantity');
  if (quantity <= 0) throw new TypeError(`quantity must be positive, got ${quantity}`);

  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (bestBid === undefined || bestAsk === undefined) {
    throw new TypeError('walkBook requires at least one bid and one ask level');
  }
  const referencePrice = (bestBid + bestAsk) / 2;

  const levels = side === 'BUY' ? [...book.asks].sort((a, b) => a.price - b.price) : [...book.bids].sort((a, b) => b.price - a.price);

  let remaining = quantity;
  let cost = 0;
  let filled = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.quantity);
    cost += take * level.price;
    filled += take;
    remaining -= take;
  }

  const depthSufficient = remaining <= 1e-9;
  if (!depthSufficient) {
    return {
      model: 'ORDERBOOK',
      expected_avg_price: NaN,
      reference_price: referencePrice,
      expected_slippage_pct: NaN,
      expected_slippage_usdt: NaN,
      fillable_quantity: filled,
      depth_sufficient: false,
      reason: 'INSUFFICIENT_DEPTH',
    };
  }

  const expectedAvgPrice = cost / filled;
  const expectedSlippagePct = Math.abs(expectedAvgPrice - referencePrice) / referencePrice;
  const expectedSlippageUsdt = Math.abs(expectedAvgPrice - referencePrice) * quantity;

  return {
    model: 'ORDERBOOK',
    expected_avg_price: expectedAvgPrice,
    reference_price: referencePrice,
    expected_slippage_pct: expectedSlippagePct,
    expected_slippage_usdt: expectedSlippageUsdt,
    fillable_quantity: filled,
    depth_sufficient: true,
  };
}

/**
 * Fallback when only best bid/ask are known: half-spread as the single-fill slippage estimate
 * (spec "無完整盤口時的退回模型").
 */
export function topOfBook(side: Side, quantity: number, quote: { bestBid: number; bestAsk: number }): TopOfBookResult {
  assertFiniteNumber(quantity, 'quantity');
  assertFiniteNumber(quote.bestBid, 'bestBid');
  assertFiniteNumber(quote.bestAsk, 'bestAsk');
  if (quantity <= 0) throw new TypeError(`quantity must be positive, got ${quantity}`);

  const referencePrice = (quote.bestBid + quote.bestAsk) / 2;
  const halfSpread = (quote.bestAsk - quote.bestBid) / 2;
  const expectedAvgPrice = side === 'BUY' ? referencePrice + halfSpread : referencePrice - halfSpread;
  const expectedSlippagePct = referencePrice > 0 ? Math.abs(halfSpread) / referencePrice : 0;
  const expectedSlippageUsdt = Math.abs(expectedAvgPrice - referencePrice) * quantity;

  return {
    model: 'TOP_OF_BOOK',
    expected_avg_price: expectedAvgPrice,
    reference_price: referencePrice,
    expected_slippage_pct: expectedSlippagePct,
    expected_slippage_usdt: expectedSlippageUsdt,
  };
}

export interface BufferedSlippage {
  slippage_safety_buffer_pct: number;
  slippage_with_buffer_pct: number;
  slippage_with_buffer_usdt: number;
}

/**
 * Adds `slippage_safety_buffer_pct` on top of a resolved slippage estimate (spec "可設定的
 * safety buffer"). Cost estimates MUST use the buffered value.
 */
export function withBuffer<T extends { expected_slippage_pct: number; reference_price: number }>(
  result: T,
  bufferPct: number,
  quantity: number,
): T & BufferedSlippage {
  assertFiniteNumber(bufferPct, 'bufferPct');
  assertFiniteNumber(quantity, 'quantity');
  const withBufferPct = result.expected_slippage_pct + bufferPct;
  const withBufferUsdt = withBufferPct * result.reference_price * quantity;
  return {
    ...result,
    slippage_safety_buffer_pct: bufferPct,
    slippage_with_buffer_pct: withBufferPct,
    slippage_with_buffer_usdt: withBufferUsdt,
  };
}
