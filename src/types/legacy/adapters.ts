/**
 * src/types/legacy/adapters.ts
 *
 * One-way v0.2 → v0.1 display adapters (spec §2.1, design.md Decision 7).
 * These exist only so the (frozen) research UI can keep showing a legacy
 * state label while new logic writes v0.2 shapes; they are NOT used by any
 * runtime/src/ code (C-11 rule 3 — the import boundary only runs the other
 * direction: runtime/src/ never imports src/, but src/ importing runtime
 * read-only types here is fine).
 *
 * Deliberately typed with plain string literals (not `import type { OrderState } from
 * '../../../runtime/src/types'`) to keep this adapter resilient to the
 * transition-table source without creating a two-way coupling; the
 * mapping is spec.md's exact table (see each function's docstring).
 */

/** v0.1 order state (src/types/systemSpec.ts `OrderState`). */
type LegacyOrderState = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';

/** v0.1 position state (src/types/systemSpec.ts `PositionState`). */
type LegacyPositionState = 'FLAT' | 'OPENING' | 'BALANCED_HEDGED' | 'LEG_IMBALANCE' | 'CLOSING' | 'EMERGENCY_EXIT';

/** Subset of v0.2 `PaperOrder` needed for the mapping. */
interface OrderStateInput {
  order_state:
    | 'CREATED'
    | 'SUBMITTED'
    | 'ACKNOWLEDGED'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'CANCEL_REQUESTED'
    | 'CANCELED'
    | 'REJECTED'
    | 'EXPIRED';
  filled_quantity: number;
}

/**
 * v0.2 `PaperOrder.order_state` → v0.1 `OrderState` (spec §2.1 mapping table).
 * `CANCEL_REQUESTED` depends on whether any quantity has filled yet.
 */
export function toLegacyOrderState(order: OrderStateInput): LegacyOrderState {
  switch (order.order_state) {
    case 'CREATED':
    case 'SUBMITTED':
    case 'ACKNOWLEDGED':
      return 'NEW';
    case 'PARTIALLY_FILLED':
      return 'PARTIALLY_FILLED';
    case 'CANCEL_REQUESTED':
      return order.filled_quantity > 0 ? 'PARTIALLY_FILLED' : 'NEW';
    case 'FILLED':
      return 'FILLED';
    case 'CANCELED':
    case 'EXPIRED':
      return 'CANCELED';
    case 'REJECTED':
      return 'REJECTED';
  }
}

type TradeStatusInput =
  | 'CREATED'
  | 'PRE_FLIGHT'
  | 'ENTRY_PENDING'
  | 'PARTIALLY_HEDGED'
  | 'LEG_IMBALANCE'
  | 'HEDGED'
  | 'EXIT_PENDING'
  | 'EMERGENCY_EXIT'
  | 'CLOSED'
  | 'ABORTED'
  | 'FAILED';

/**
 * v0.2 `Trade.status` → v0.1 `PositionState` (spec §2.1 mapping table).
 * `FAILED` has no legacy equivalent — returns `null`, UI shows the v0.2 code.
 */
export function toLegacyPositionState(status: TradeStatusInput): LegacyPositionState | null {
  switch (status) {
    case 'CREATED':
    case 'PRE_FLIGHT':
    case 'ABORTED':
    case 'CLOSED':
      return 'FLAT';
    case 'ENTRY_PENDING':
    case 'PARTIALLY_HEDGED':
      return 'OPENING';
    case 'HEDGED':
      return 'BALANCED_HEDGED';
    case 'LEG_IMBALANCE':
      return 'LEG_IMBALANCE';
    case 'EXIT_PENDING':
      return 'CLOSING';
    case 'EMERGENCY_EXIT':
      return 'EMERGENCY_EXIT';
    case 'FAILED':
      return null;
  }
}
