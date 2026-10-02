/**
 * runtime/src/types/trade.ts
 *
 * `Trade` (spec §6) and `TradeLeg` (spec §8), verbatim field names.
 * `Trade.mode` is intentionally `'PAPER' | 'BACKTEST'` only — `'LIVE'` is
 * reserved and MUST NOT be added without explicit approval (C-18).
 */
import type { ExchangeId } from './ids';
import type { TradeStatus, LegStatus } from './status';
import type { RiskStatusReport } from './risk';

export interface Trade {
  trade_id: string;
  opportunity_id: string;

  strategy_id: string;
  strategy_version: string;
  config_version: string;

  symbol: string;

  /** C-18: 'LIVE' reserved, not an allowed value without explicit approval. */
  mode: 'PAPER' | 'BACKTEST';

  created_at: number;
  updated_at: number;
  entry_started_at?: number;
  entry_completed_at?: number;
  exit_started_at?: number;
  exit_completed_at?: number;

  status: TradeStatus;
  close_reason?: 'NORMAL_EXIT' | 'EMERGENCY_EXIT' | 'KILL_SWITCH';

  target_notional_per_leg_usdt: number;
  leverage: number;
  allocated_margin_usdt: number;
  allocated_capital_usdt: number;

  legs: TradeLeg[];

  expected_pnl_usdt: number;
  realized_pnl_usdt?: number;

  /** Reused as-is from `src/types/systemSpec.ts` (spec §6) — see `risk.ts`. */
  risk_status: RiskStatusReport;
}

export interface TradeLeg {
  leg_id: string;
  trade_id: string;

  exchange: ExchangeId;
  symbol: string;

  direction: 'LONG' | 'SHORT';
  order_side: 'BUY' | 'SELL';

  leverage: number;

  target_notional_usdt: number;
  target_quantity: number;
  actual_notional_usdt?: number;
  actual_quantity?: number;

  margin_allocated_usdt: number;

  target_entry_price: number;
  average_entry_price?: number;
  average_exit_price?: number;

  entry_order_ids: string[];
  exit_order_ids: string[];

  status: LegStatus;

  created_at: number;
  updated_at: number;
  entry_started_at?: number;
  entry_completed_at?: number;
  exit_started_at?: number;
  exit_completed_at?: number;
}
