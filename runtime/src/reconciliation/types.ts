/**
 * runtime/src/reconciliation/types.ts
 *
 * Shared types for the `reconciliation` capability (design.md Decision 1/2).
 * `ReconciliationConfig` fields are owned `PaperTradingConfig` fields
 * (proposal.md "Impact") — no aggregate `PaperTradingConfig` interface
 * exists yet in the codebase (see design.md "Implementation Notes
 * (Task Group 1-3)"), so this capability defines its own local config
 * interface, following the `RiskConfig` / `SessionTimingConfig` precedent.
 */
import type { AccountSnapshot, Fill, PaperOrder, PaperPosition } from '../types';
import type { Trade } from '../types/trade';

/** One check-ID + entity mismatch found during a reconciliation pass (design.md Decision 1 table). */
export interface Mismatch {
  check_id: string;
  /** The row the mismatch was found on — order_id / position_id / trade_id / leg_id, as applicable. */
  entity_id: string;
  /** `null` when the check is not scoped to a single Trade (design.md Decision 2: `RECONCILIATION_ERROR.trade_id` may be `null`). */
  trade_id: string | null;
  details: string;
}

export interface ReconciliationConfig {
  /** `reconciliation_interval_ms`; default 5_000 (proposal.md "What Changes"). */
  intervalMs: number;
  /** `reconciliation_qty_epsilon`; default 1e-9 (design.md Decision 1 "容差"). */
  qtyEpsilon: number;
  /** `reconciliation_usdt_epsilon`; default 1e-6 (design.md Decision 1 "容差"). */
  usdtEpsilon: number;
  /** `reconciliation_lookback_ms`; default 24h — only non-terminal Trades + Trades closed within this window are checked (design.md Decision 1 "效能"). */
  lookbackMs: number;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  intervalMs: 5_000,
  qtyEpsilon: 1e-9,
  usdtEpsilon: 1e-6,
  lookbackMs: 24 * 60 * 60 * 1000,
};

/**
 * The last recorded state-transition for one entity (for `PROJECTION_EVENT`
 * — design.md Decision 1 "投影列狀態 vs 最後轉換事件", spec §25 #2). `to` is
 * `payload.to` from the entity's latest `*_STATUS_CHANGED` /
 * `ORDER_*` transition event; `status` is the entity's current projection
 * row status. A mismatch means the projection wasn't updated to match the
 * last recorded transition.
 */
export interface ProjectionCheckEntry {
  kind: 'ORDER' | 'TRADE' | 'LEG';
  entity_id: string;
  trade_id: string | null;
  projected_status: string;
  last_event_to: string | null;
}

/** One Order plus the Fills recorded against it (Fill.order_id === order.order_id). */
export interface OrderWithFills {
  order: PaperOrder;
  fills: Fill[];
}

/** One Trade plus its open/closed Positions and the orders/fills for its legs (for POSITION_FILL_NET / TRADE_* checks). */
export interface TradeSnapshot {
  trade: Trade;
  positions: PaperPosition[];
  orders: OrderWithFills[];
}

/**
 * A consistent read of everything one reconciliation pass needs (design.md
 * Decision 1 "一致快照": read inside one `BEGIN ... COMMIT`). Built by
 * `reconciler.ts` from the repositories; `checks.ts` itself never touches
 * the DB (pure functions only).
 */
export interface ReconciliationSnapshot {
  trades: TradeSnapshot[];
  accountSnapshot: AccountSnapshot | undefined;
  projections: ProjectionCheckEntry[];
  /** Count of `CAPITAL_RESERVED` / `CAPITAL_RELEASED` events recorded per trade_id, for CAPITAL_EVENT_PAIRING. */
  capitalEventCounts: Map<string, { reserved: number; released: number }>;
}
