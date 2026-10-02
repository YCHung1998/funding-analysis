/**
 * runtime/src/reconciliation/checks.ts
 *
 * Pure reconciliation check functions (design.md Decision 1 table: Order vs
 * Fill, Order state vs qty/time, Position vs Fill, Trade vs Position,
 * Capital vs Trade/event, Projection vs last event). Every function here is
 * a pure function of its inputs plus `ReconciliationConfig` — no DB access,
 * no Clock, no I/O — so `reconciler.ts` can run them against one consistent
 * in-memory snapshot (design.md Decision 1 "一致快照").
 *
 * tech spec §31's worked example ("Order 記錄 1000，Fill 總和 900") is
 * `checkOrderFillSum` — see `checks.test.ts`.
 */
import type { AccountSnapshot } from '../types/account';
import type { Fill } from '../types/fill';
import type { PaperOrder } from '../types/order';
import type { PaperPosition } from '../types/account';
import type { Trade } from '../types/trade';
import { ORDER_TERMINAL_STATES } from '../types/status';
import type { Mismatch, ProjectionCheckEntry, ReconciliationConfig } from './types';

function mismatch(check_id: string, entity_id: string, trade_id: string | null, details: string): Mismatch {
  return { check_id, entity_id, trade_id, details };
}

function sumQuantity(fills: Fill[]): number {
  return fills.reduce((acc, f) => acc + f.quantity, 0);
}

function weightedAvgPrice(fills: Fill[]): number | undefined {
  const qty = sumQuantity(fills);
  if (qty <= 0) return undefined;
  const notional = fills.reduce((acc, f) => acc + f.quantity * f.price, 0);
  return notional / qty;
}

// ---------------------------------------------------------------------------
// Order vs Fill (design.md Decision 1: ORDER_FILL_SUM / ORDER_AVG_PRICE / ORDER_REMAINING)
// ---------------------------------------------------------------------------

/** tech spec §31 worked example: Order.filled_quantity vs Sigma(fills.quantity). */
export function checkOrderFillSum(order: PaperOrder, fills: Fill[], cfg: ReconciliationConfig): Mismatch[] {
  const fillSum = sumQuantity(fills);
  if (Math.abs(order.filled_quantity - fillSum) > cfg.qtyEpsilon) {
    return [
      mismatch(
        'ORDER_FILL_SUM',
        order.order_id,
        order.trade_id,
        `order.filled_quantity=${order.filled_quantity} vs sum(fills.quantity)=${fillSum}`,
      ),
    ];
  }
  return [];
}

export function checkOrderAvgPrice(order: PaperOrder, fills: Fill[], cfg: ReconciliationConfig): Mismatch[] {
  const expected = weightedAvgPrice(fills);
  if (expected === undefined) return [];
  const actual = order.average_fill_price;
  if (actual === undefined || Math.abs(actual - expected) > cfg.usdtEpsilon) {
    return [
      mismatch(
        'ORDER_AVG_PRICE',
        order.order_id,
        order.trade_id,
        `order.average_fill_price=${actual} vs fill-weighted average=${expected}`,
      ),
    ];
  }
  return [];
}

export function checkOrderRemaining(order: PaperOrder, cfg: ReconciliationConfig): Mismatch[] {
  const expected = order.requested_quantity - order.filled_quantity;
  if (Math.abs(order.remaining_quantity - expected) > cfg.qtyEpsilon) {
    return [
      mismatch(
        'ORDER_REMAINING',
        order.order_id,
        order.trade_id,
        `order.remaining_quantity=${order.remaining_quantity} vs requested-filled=${expected}`,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Order state vs qty/time (design.md Decision 1, C-14)
// ---------------------------------------------------------------------------

const PRE_FILL_STATES = new Set(['CREATED', 'SUBMITTED']);

export function checkOrderStateQty(order: PaperOrder, cfg: ReconciliationConfig): Mismatch[] {
  const out: Mismatch[] = [];
  if (PRE_FILL_STATES.has(order.order_state) && order.filled_quantity > cfg.qtyEpsilon) {
    out.push(
      mismatch(
        'ORDER_STATE_QTY',
        order.order_id,
        order.trade_id,
        `order_state=${order.order_state} but filled_quantity=${order.filled_quantity}`,
      ),
    );
  }
  if (order.order_state === 'FILLED' && Math.abs(order.filled_quantity - order.requested_quantity) > cfg.qtyEpsilon) {
    out.push(
      mismatch(
        'ORDER_STATE_QTY',
        order.order_id,
        order.trade_id,
        `order_state=FILLED but filled_quantity=${order.filled_quantity} != requested_quantity=${order.requested_quantity}`,
      ),
    );
  }
  if (order.order_state === 'PARTIALLY_FILLED' && (order.filled_quantity <= cfg.qtyEpsilon || order.remaining_quantity <= cfg.qtyEpsilon)) {
    out.push(
      mismatch(
        'ORDER_STATE_QTY',
        order.order_id,
        order.trade_id,
        `order_state=PARTIALLY_FILLED but filled_quantity=${order.filled_quantity} remaining_quantity=${order.remaining_quantity}`,
      ),
    );
  }
  return out;
}

export function checkOrderTerminalTime(order: PaperOrder): Mismatch[] {
  const isTerminal = (ORDER_TERMINAL_STATES as readonly string[]).includes(order.order_state);
  if (isTerminal && order.terminal_time === undefined) {
    return [mismatch('ORDER_TERMINAL_TIME', order.order_id, order.trade_id, `order_state=${order.order_state} but terminal_time is unset`)];
  }
  return [];
}

/**
 * `Ledger.createOrder` always commits `CREATED -> SUBMITTED` in the same
 * transaction — `CREATED` is never persisted on its own row. Finding one
 * persisted as `CREATED` means it was orphaned mid-submit (C-14).
 */
export function checkOrderOrphanCreated(order: PaperOrder): Mismatch[] {
  if (order.order_state === 'CREATED') {
    return [mismatch('ORDER_ORPHAN_CREATED', order.order_id, order.trade_id, 'order persisted in state CREATED (should never be persisted)')];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Position vs Fill (design.md Decision 1: POSITION_FILL_NET)
// ---------------------------------------------------------------------------

/** position.quantity vs entry_filled_quantity - exit_filled_quantity (both additive, position-funding-pnl). */
export function checkPositionFillNet(position: PaperPosition, cfg: ReconciliationConfig): Mismatch[] {
  const expected = position.entry_filled_quantity - position.exit_filled_quantity;
  if (Math.abs(position.quantity - expected) > cfg.qtyEpsilon) {
    return [
      mismatch(
        'POSITION_FILL_NET',
        position.position_id,
        position.trade_id,
        `position.quantity=${position.quantity} vs entry_filled-exit_filled=${expected}`,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Trade vs Position (design.md Decision 1: TRADE_CLOSED_NOT_FLAT / TRADE_HEDGED_FLAT)
// ---------------------------------------------------------------------------

function isFlat(positions: PaperPosition[], cfg: ReconciliationConfig): boolean {
  return positions.every((p) => Math.abs(p.quantity) <= cfg.qtyEpsilon);
}

export function checkTradeClosedNotFlat(trade: Trade, positions: PaperPosition[], cfg: ReconciliationConfig): Mismatch[] {
  if (trade.status === 'CLOSED' && !isFlat(positions, cfg)) {
    return [mismatch('TRADE_CLOSED_NOT_FLAT', trade.trade_id, trade.trade_id, 'trade.status=CLOSED but a position is still open (not flat)')];
  }
  return [];
}

export function checkTradeHedgedFlat(trade: Trade, positions: PaperPosition[], cfg: ReconciliationConfig): Mismatch[] {
  if (trade.status === 'HEDGED' && isFlat(positions, cfg)) {
    return [mismatch('TRADE_HEDGED_FLAT', trade.trade_id, trade.trade_id, 'trade.status=HEDGED but no position is open (all flat)')];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Projection vs last transition event (design.md Decision 1: PROJECTION_EVENT, spec §25 #2)
// ---------------------------------------------------------------------------

export function checkProjectionEvent(entry: ProjectionCheckEntry): Mismatch[] {
  if (entry.last_event_to === null) return [];
  if (entry.projected_status !== entry.last_event_to) {
    return [
      mismatch(
        'PROJECTION_EVENT',
        entry.entity_id,
        entry.trade_id,
        `${entry.kind} projected_status=${entry.projected_status} vs last transition event payload.to=${entry.last_event_to}`,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Capital (design.md Decision 1: CAPITAL_RESERVED_SUM / CAPITAL_AVAILABLE / CAPITAL_EVENT_PAIRING, §12)
// ---------------------------------------------------------------------------

const TERMINAL_TRADE_STATUSES = new Set(['CLOSED', 'ABORTED', 'FAILED']);

/** Sum of allocated_capital_usdt over non-terminal trades vs account_snapshots.reserved_capital_usdt. */
export function checkCapitalReservedSum(trades: Trade[], snapshot: AccountSnapshot | undefined, cfg: ReconciliationConfig): Mismatch[] {
  if (!snapshot) return [];
  const expected = trades.filter((t) => !TERMINAL_TRADE_STATUSES.has(t.status)).reduce((acc, t) => acc + t.allocated_capital_usdt, 0);
  if (Math.abs(snapshot.reserved_capital_usdt - expected) > cfg.usdtEpsilon) {
    return [
      mismatch(
        'CAPITAL_RESERVED_SUM',
        snapshot.snapshot_id,
        null,
        `account.reserved_capital_usdt=${snapshot.reserved_capital_usdt} vs sum(non-terminal trade allocations)=${expected}`,
      ),
    ];
  }
  return [];
}

/** total - reserved should equal available (spec.md "ledger identity"; re-checked here at the reconciliation pass level, not just on write). */
export function checkCapitalAvailable(snapshot: AccountSnapshot | undefined, cfg: ReconciliationConfig): Mismatch[] {
  if (!snapshot) return [];
  const expected = snapshot.total_capital_usdt - snapshot.reserved_capital_usdt;
  if (Math.abs(snapshot.available_capital_usdt - expected) > cfg.usdtEpsilon) {
    return [
      mismatch(
        'CAPITAL_AVAILABLE',
        snapshot.snapshot_id,
        null,
        `account.available_capital_usdt=${snapshot.available_capital_usdt} vs total-reserved=${expected}`,
      ),
    ];
  }
  return [];
}

/**
 * Every Trade must have exactly one `CAPITAL_RESERVED` event; every
 * *terminal* Trade must additionally have exactly one `CAPITAL_RELEASED`
 * event (design.md Decision 1 "每筆 Trade 都有對應 CAPITAL_RESERVED，終態
 * Trade 都有 CAPITAL_RELEASED").
 */
export function checkCapitalEventPairing(
  trade: Trade,
  counts: { reserved: number; released: number } | undefined,
): Mismatch[] {
  const out: Mismatch[] = [];
  const reserved = counts?.reserved ?? 0;
  const released = counts?.released ?? 0;
  if (reserved !== 1) {
    out.push(mismatch('CAPITAL_EVENT_PAIRING', trade.trade_id, trade.trade_id, `trade has ${reserved} CAPITAL_RESERVED events (expected 1)`));
  }
  if (TERMINAL_TRADE_STATUSES.has(trade.status) && released !== 1) {
    out.push(
      mismatch(
        'CAPITAL_EVENT_PAIRING',
        trade.trade_id,
        trade.trade_id,
        `terminal trade (status=${trade.status}) has ${released} CAPITAL_RELEASED events (expected 1)`,
      ),
    );
  }
  if (!TERMINAL_TRADE_STATUSES.has(trade.status) && released > 0) {
    out.push(
      mismatch(
        'CAPITAL_EVENT_PAIRING',
        trade.trade_id,
        trade.trade_id,
        `non-terminal trade (status=${trade.status}) already has ${released} CAPITAL_RELEASED events`,
      ),
    );
  }
  return out;
}
