/**
 * runtime/src/types/account.ts
 *
 * `AccountSnapshot` (virtual paper ledger, tech spec §5 note / §29) and
 * `PaperPosition` (storage row; computation semantics owned by
 * `position-accounting`) — spec.md "Supporting entity shapes" requirement.
 *
 * Name note (design.md Open Question 4): tech spec §5
 * `ExchangeAdapter.getAccount(): Promise<AccountSnapshot>` refers to a
 * read-only exchange account info shape (fee tier / rate limits), which is
 * a different thing from the ledger snapshot defined here. This module
 * defines `AccountSnapshot` = the virtual ledger per spec §29; the adapter
 * return type is out of scope for this capability (left to the adapter's
 * owning change to rename, e.g. `ExchangeAccountInfo`).
 */
import type { ExchangeId } from './ids';

export interface AccountSnapshot {
  snapshot_id: string;
  mode: 'PAPER' | 'BACKTEST';
  snapshot_time: number;
  total_capital_usdt: number;
  reserved_capital_usdt: number;
  available_capital_usdt: number;
  used_margin_usdt: number;
  realized_pnl_usdt: number;
  open_trade_count: number;
  reason: 'INITIAL' | 'CAPITAL_RESERVED' | 'CAPITAL_RELEASED' | 'PNL_REALIZED' | 'FUNDING_SETTLED' | 'PERIODIC';
  trade_id?: string;
  config_version: string;
  created_at: number;
  updated_at: number;
}

/** Storage row; position-level computation semantics belong to `position-accounting`. */
export interface PaperPosition {
  position_id: string;
  trade_id: string;
  leg_id: string;
  exchange: ExchangeId;
  symbol: string;
  position_side: 'LONG' | 'SHORT';
  quantity: number;
  average_entry_price: number;
  status: 'OPEN' | 'CLOSED';
  opened_at: number;
  closed_at?: number;
  created_at: number;
  updated_at: number;
}
