/**
 * runtime/src/trading/positionManager.ts
 *
 * `position-accounting` capability: Position derived from Fills
 * (position-funding-pnl design.md Decision 2/3, tasks.md 1.1-1.3; spec §11,
 * §13-14, §20-21). `applyFill` is a **pure function** — it never touches
 * the database; the caller commits the returned `PaperPosition` (and
 * `POSITION_OPENED`/`POSITION_CLOSED` event) atomically via
 * `Ledger.applyFill` (design.md Decision 2 "positionManager 本身是純函式，
 * 不碰資料庫").
 *
 * Classification rule (design.md Decision 3): `order_id ∈ entry_order_ids`
 * -> entry; `∈ exit_order_ids` -> exit (never inferred from BUY/SELL,
 * because a SHORT's entry is a SELL and a LONG's exit is also a SELL).
 */
import type { Fill } from '../types/fill';
import type { PaperPosition } from '../types/account';
import { slippageAttribution, type OrderSide } from '../accounting/pnlFormula';

const QUANTITY_TOLERANCE = 1e-9;

export type ApplyFillErrorCode = 'UNKNOWN_ORDER' | 'POSITION_OVERCLOSE' | 'UNSUPPORTED_FEE_ASSET' | 'RECONCILIATION_ERROR';

export class ApplyFillError extends Error {
  constructor(
    public readonly code: ApplyFillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApplyFillError';
  }
}

export interface ApplyFillInput {
  fill: Fill;
  /** The Fill's order's `reference_price` (paper-execution `OrderRequest.reference_price`, spec §16). */
  orderReferencePrice: number;
  orderSide: OrderSide;
  /** `TradeLeg.entry_order_ids` / `exit_order_ids` (design.md Decision 3 classification). */
  entryOrderIds: readonly string[];
  exitOrderIds: readonly string[];
  positionSide: 'LONG' | 'SHORT';
  /** `instrument-registry`'s `qty_unit_in_base` for this instrument (base-asset units per contract). */
  contractMultiplier: number;
  /** Clock time for created_at/updated_at/opened_at/closed_at (VirtualClock only). */
  now: number;
  /** Existing Position state, or `undefined` if this is the first Fill for the leg. */
  position?: PaperPosition;
  /** Identity fields for a brand-new Position (only consulted when `position` is `undefined`). */
  newPositionIdentity?: Pick<PaperPosition, 'position_id' | 'trade_id' | 'leg_id' | 'exchange' | 'symbol'>;
}

export type PositionEventType = 'POSITION_OPENED' | 'POSITION_CLOSED';

export interface ApplyFillOk {
  ok: true;
  position: PaperPosition;
  /** `null` when the Fill was a no-op (duplicate) or did not cross an OPEN/CLOSED boundary. */
  event: PositionEventType | null;
}

export interface ApplyFillErr {
  ok: false;
  errorCode: ApplyFillErrorCode;
  message: string;
}

export type ApplyFillOutcome = ApplyFillOk | ApplyFillErr;

function err(code: ApplyFillErrorCode, message: string): ApplyFillErr {
  return { ok: false, errorCode: code, message };
}

function weightedAverage(qtyA: number, priceA: number, qtyB: number, priceB: number): number {
  const totalQty = qtyA + qtyB;
  if (totalQty <= 0) return 0;
  return (qtyA * priceA + qtyB * priceB) / totalQty;
}

/**
 * Derives (or updates) a `PaperPosition` from one Fill. Idempotent on
 * `fill.fill_id` (design.md Decision 3 "冪等：以 fill_id 去重") — re-applying
 * an already-applied Fill is a no-op (`event: null`, position unchanged).
 */
export function applyFill(input: ApplyFillInput): ApplyFillOutcome {
  const { fill, position } = input;

  if (fill.fee_asset !== 'USDT') {
    return err('UNSUPPORTED_FEE_ASSET', `applyFill: unsupported fee_asset "${fill.fee_asset}" (only USDT is supported)`);
  }

  const isEntry = input.entryOrderIds.includes(fill.order_id);
  const isExit = input.exitOrderIds.includes(fill.order_id);
  if (!isEntry && !isExit) {
    return err('UNKNOWN_ORDER', `applyFill: order_id "${fill.order_id}" is neither an entry nor exit order for this leg`);
  }

  if (position && position.applied_fill_ids.includes(fill.fill_id)) {
    return { ok: true, position, event: null };
  }

  const fillSlippage = slippageAttribution(input.orderSide, fill.quantity, fill.price, input.orderReferencePrice);

  // ---- First Fill for this leg ----
  if (!position) {
    if (isExit) {
      // Exit Fill arrived before any entry Fill ever did — reject rather than
      // silently correcting (design.md Decision 3 "先暫存...第一版採拒絕 +
      // RECONCILIATION_ERROR").
      return err('RECONCILIATION_ERROR', 'applyFill: exit Fill arrived with no prior Position (out-of-order Fill)');
    }
    if (!input.newPositionIdentity) {
      throw new Error('applyFill: newPositionIdentity is required to open a Position from the first Fill');
    }
    const baseQuantity = fill.quantity * input.contractMultiplier;
    const created: PaperPosition = {
      ...input.newPositionIdentity,
      position_side: input.positionSide,
      quantity: fill.quantity,
      average_entry_price: fill.price,
      status: 'OPEN',
      opened_at: input.now,
      created_at: input.now,
      updated_at: input.now,
      base_quantity: baseQuantity,
      entry_filled_quantity: fill.quantity,
      exit_filled_quantity: 0,
      entry_notional_usdt: fill.notional_usdt,
      realized_price_pnl_usdt: 0,
      fees_usdt: fill.fee_usdt,
      slippage_attribution_usdt: fillSlippage,
      applied_fill_ids: [fill.fill_id],
    };
    return { ok: true, position: created, event: 'POSITION_OPENED' };
  }

  if (position.status === 'CLOSED') {
    // No cross-period positions (D-1): a Fill against an already-CLOSED
    // Position is always an error, whether it claims to be entry or exit.
    return err('RECONCILIATION_ERROR', 'applyFill: Fill received for an already-CLOSED Position (no cross-period positions, D-1)');
  }

  // ---- Entry Fill on an existing OPEN position: weighted-average update ----
  if (isEntry) {
    const newQuantity = position.quantity + fill.quantity;
    const newAveragePrice = weightedAverage(position.quantity, position.average_entry_price, fill.quantity, fill.price);
    const updated: PaperPosition = {
      ...position,
      quantity: newQuantity,
      average_entry_price: newAveragePrice,
      base_quantity: position.base_quantity + fill.quantity * input.contractMultiplier,
      entry_filled_quantity: position.entry_filled_quantity + fill.quantity,
      entry_notional_usdt: position.entry_notional_usdt + fill.notional_usdt,
      fees_usdt: position.fees_usdt + fill.fee_usdt,
      slippage_attribution_usdt: position.slippage_attribution_usdt + fillSlippage,
      applied_fill_ids: [...position.applied_fill_ids, fill.fill_id],
      updated_at: input.now,
    };
    return { ok: true, position: updated, event: null };
  }

  // ---- Exit Fill: realize Price PnL fill-by-fill, average_entry_price unchanged ----
  if (fill.quantity > position.quantity + QUANTITY_TOLERANCE) {
    return err(
      'POSITION_OVERCLOSE',
      `applyFill: exit Fill quantity ${fill.quantity} exceeds open quantity ${position.quantity}`,
    );
  }

  const thisFillPnl =
    input.positionSide === 'LONG'
      ? (fill.price - position.average_entry_price) * fill.quantity
      : (position.average_entry_price - fill.price) * fill.quantity;

  const newExitFilledQuantity = position.exit_filled_quantity + fill.quantity;
  const newAverageExitPrice = weightedAverage(
    position.exit_filled_quantity,
    position.average_exit_price ?? 0,
    fill.quantity,
    fill.price,
  );
  const remainingQuantity = position.quantity - fill.quantity;
  const remainingBaseQuantity = position.base_quantity - fill.quantity * input.contractMultiplier;
  const closing = remainingQuantity <= QUANTITY_TOLERANCE;

  const updated: PaperPosition = {
    ...position,
    quantity: closing ? 0 : remainingQuantity,
    base_quantity: closing ? 0 : remainingBaseQuantity,
    exit_filled_quantity: newExitFilledQuantity,
    average_exit_price: newAverageExitPrice,
    realized_price_pnl_usdt: position.realized_price_pnl_usdt + thisFillPnl,
    fees_usdt: position.fees_usdt + fill.fee_usdt,
    slippage_attribution_usdt: position.slippage_attribution_usdt + fillSlippage,
    applied_fill_ids: [...position.applied_fill_ids, fill.fill_id],
    updated_at: input.now,
    status: closing ? 'CLOSED' : 'OPEN',
    closed_at: closing ? input.now : position.closed_at,
  };

  return { ok: true, position: updated, event: closing ? 'POSITION_CLOSED' : null };
}

/** Unrealized PnL for an OPEN position against a mark price (tech spec §22). */
export function unrealizedPnl(position: Pick<PaperPosition, 'position_side' | 'quantity' | 'average_entry_price'>, markPrice: number): number {
  return position.position_side === 'LONG'
    ? (markPrice - position.average_entry_price) * position.quantity
    : (position.average_entry_price - markPrice) * position.quantity;
}
