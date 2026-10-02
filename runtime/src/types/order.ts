/**
 * runtime/src/types/order.ts
 *
 * `PaperOrder` — spec §10, verbatim field names. `OrderState` lives in
 * `status.ts` (single source for state enums); re-exported here for
 * convenience since spec §10 declares it alongside `PaperOrder`.
 * `OrderRequest` (execution-adapter input) is NOT defined here — it belongs
 * to `paper-execution-engine` (design.md Decision 1).
 */
import type { ExchangeId } from './ids';
import type { OrderState } from './status';

export type { OrderState };

export interface PaperOrder {
  order_id: string;
  client_order_id: string;

  trade_id: string;
  leg_id: string;
  purpose: 'ENTRY' | 'EXIT' | 'EMERGENCY_CLOSE';

  exchange: ExchangeId;
  symbol: string;

  order_type: 'MARKET' | 'LIMIT';
  side: 'BUY' | 'SELL';
  position_side: 'LONG' | 'SHORT';
  /** EXIT / EMERGENCY_CLOSE 必為 true；ENTRY 必為 false（Invariant #6, validate.ts）。 */
  reduce_only: boolean;

  requested_quantity: number;
  requested_notional_usdt: number;
  requested_price?: number;
  reference_price: number;

  order_state: OrderState;

  created_at: number;
  updated_at: number;
  submit_time?: number;
  ack_time?: number;
  first_fill_time?: number;
  final_fill_time?: number;
  cancel_request_time?: number;
  cancel_ack_time?: number;
  terminal_time?: number;

  filled_quantity: number;
  remaining_quantity: number;
  average_fill_price?: number;

  estimated_fee_usdt: number;
  actual_fee_usdt?: number;

  estimated_slippage_pct: number;
  actual_slippage_pct?: number;

  rejection_reason?: string;
  timeout_reason?: string;
  cancel_reject_reason?: string;
}
