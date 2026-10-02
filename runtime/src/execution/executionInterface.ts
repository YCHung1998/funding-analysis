/**
 * runtime/src/execution/executionInterface.ts
 *
 * `paper-execution-engine` capability — design.md Decision 1 / spec
 * "Replaceable execution interface" (tech spec §46). `ExecutionEngine` is the
 * only thing Strategy / trade coordinators / risk code may depend on; never
 * `PaperExecutionAdapter` directly (Scenario "Coordinators do not know the
 * implementation", enforced by `runtime/test/executionArchitecture.test.ts`).
 *
 * The five port interfaces below are *consumed* by this capability but
 * *provided* by other (not-yet-merged) capabilities — `market-data-stream`,
 * `instrument-registry`, `cost-model`, `position-accounting`,
 * `funding-settlement-rules`. Until those land, `runtime/test/fakes/`
 * supplies fakes with the same shape (design.md Risks: "上游 port 尚未實作").
 */
import type { ExchangeId } from '../types/ids';
import type { Fill } from '../types/fill';
import type { PaperOrder } from '../types/order';

/**
 * Execution-adapter input (spec §4, verbatim field names). Deliberately not
 * declared in `runtime/src/types/` — `trading-schema-types` owns `PaperOrder`
 * itself but not its submission request shape (design.md Decision 1).
 */
export interface OrderRequest {
  client_order_id: string;
  trade_id: string;
  leg_id: string;
  purpose: 'ENTRY' | 'EXIT' | 'EMERGENCY_CLOSE';
  exchange: ExchangeId;
  symbol: string;
  order_type: 'MARKET' | 'LIMIT';
  side: 'BUY' | 'SELL';
  position_side: 'LONG' | 'SHORT';
  reduce_only: boolean;
  requested_quantity: number;
  requested_notional_usdt: number;
  requested_price?: number;
  reference_price: number;
  estimated_fee_usdt: number;
  estimated_slippage_pct: number;
  /** Default resolved from `PaperExecutionAdapterConfig.market_order_time_in_force` (default 'GTC') when omitted. */
  time_in_force?: 'GTC' | 'IOC';
}

/**
 * Replaceable execution port (spec "Replaceable execution interface", tech
 * spec §46). `PaperExecutionAdapter` implements this today; a future
 * `LiveExecutionEngine` (explicitly out of scope here, Non-goal #1) would
 * implement the identical interface so Strategy/coordinators never change.
 */
export interface ExecutionEngine {
  /** Resolves once the order is `SUBMITTED` (same transaction as creation) — not once it fills. */
  submit(request: OrderRequest): Promise<PaperOrder>;
  /** Requests cancellation; resolves once the cancel outcome (or its deferral) is known. Throws `ORDER_NOT_CANCELABLE` for a terminal order. */
  cancel(orderId: string): Promise<PaperOrder>;
  getOrder(orderId: string): Promise<PaperOrder>;
  /**
   * design.md Decision 1 — supplement to tech spec §46: async fills need a push
   * channel, or a coordinator could only poll `getOrder`. Returns an unsubscribe
   * function. NOT a replacement for the EventQueue (observation-only, never a
   * trading-logic dependency, design.md Decision 1 "替代方案").
   */
  onOrderUpdate(listener: (order: PaperOrder, fills: Fill[]) => void): () => void;
}

// ---------------------------------------------------------------------------
// Ports — provided by other capabilities; design.md Decision 1 code block.
// ---------------------------------------------------------------------------

export interface OrderBookLevel {
  price: number;
  qty: number;
}

/** Shape-compatible subset of `websocket-data-layer`'s `OrderBookSnapshot` (market-data-stream). */
export interface OrderBookSnapshot {
  exchange: ExchangeId;
  symbol: string;
  local_received_timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

/** Provided by `market-data-stream` in production; `runtime/test/fakes/fakeOrderBook.ts` in tests. */
export interface OrderBookSource {
  getOrderBook(exchange: ExchangeId, symbol: string): OrderBookSnapshot | undefined;
  onUpdate(listener: (snapshot: OrderBookSnapshot) => void): () => void;
}

/** Provided by `instrument-registry` in production. */
export interface InstrumentSource {
  getInstrument(exchange: ExchangeId, symbol: string): { step_size: number; contract_multiplier: number } | undefined;
}

/** Provided by `cost-model` in production (`FeeTierConfig`'s `maker_fee`/`taker_fee`, decimals). */
export interface FeeRateSource {
  getTakerFeeRate(exchange: ExchangeId, symbol: string): number;
  getMakerFeeRate(exchange: ExchangeId, symbol: string): number;
}

/** Provided by `position-accounting` in production (`PaperPosition.quantity`-level open size). */
export interface PositionReader {
  getOpenQuantity(legId: string): number;
}

export type GuardResult = { allowed: true } | { allowed: false; reason: string };

/** Provided by `funding-settlement-rules` in production; only called, never reimplemented (Non-goal). */
export interface FundingWindowGuard {
  canSubmitEntry(tradeId: string, now: number): GuardResult;
  canSubmitExit(tradeId: string, purpose: 'EXIT' | 'EMERGENCY_CLOSE', now: number): GuardResult;
}
