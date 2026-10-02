/**
 * runtime/src/types/result.ts
 *
 * `TradeResult` — spec §21, verbatim field names, plus additive
 * `created_at`/`updated_at` (design.md Decision 2, spec §25 #1) and
 * `funding_confirmed` (design.md Decision 2 / spec.md requirement);
 * `finalized_at` is made optional (spec §21 has it required, but a closed
 * trade can be pending funding confirmation — `funding_confirmed = false`
 * with `finalized_at` unset is valid until every leg's settlement reaches a
 * terminal status).
 */
import type { ExchangeId } from './ids';

export interface TradeResult {
  trade_id: string;
  symbol: string;
  mode: 'PAPER' | 'BACKTEST';

  long_exchange: ExchangeId;
  short_exchange: ExchangeId;

  target_notional_per_leg_usdt: number;
  actual_long_notional_usdt: number;
  actual_short_notional_usdt: number;
  leverage: number;

  entry_duration_ms: number;
  exit_duration_ms: number;
  total_trade_duration_ms: number;

  funding_pnl_usdt: number;
  price_pnl_usdt: number;
  fee_usdt: number;
  slippage_attribution_usdt: number;
  net_pnl_usdt: number;

  roi_on_capital_pct: number;
  roi_on_notional_pct: number;

  max_leg_imbalance_usdt: number;
  max_leg_imbalance_duration_ms: number;

  final_status: 'PROFIT' | 'LOSS' | 'BREAK_EVEN' | 'ABORTED' | 'FAILED' | 'EMERGENCY_EXIT';
  result_reason: string;

  /** Spec §21 has this required; made optional (design.md Decision 2) — see file header. */
  finalized_at?: number;

  /** Additive (design.md Decision 2) — true once funding settlement is confirmed for every leg. */
  funding_confirmed: boolean;
  /** Additive (design.md Decision 2, spec §25 #1). */
  created_at: number;
  /** Additive (design.md Decision 2, spec §25 #1). */
  updated_at: number;
}
