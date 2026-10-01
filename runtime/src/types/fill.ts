/**
 * runtime/src/types/fill.ts
 *
 * `Fill` — spec §11, verbatim field names, plus additive `created_at` /
 * `updated_at` (design.md Decision 2: fills are immutable, both equal
 * `recorded_at`). `timestamp` (match time) and `recorded_at` (write time)
 * stay distinct (spec §25 #5).
 */
import type { ExchangeId } from './ids';

export interface Fill {
  fill_id: string;
  order_id: string;
  trade_id: string;
  leg_id: string;

  exchange: ExchangeId;
  /** Match (simulated execution) time. */
  timestamp: number;
  /** Write time; equals `created_at` / `updated_at` since fills are immutable. */
  recorded_at: number;

  /** Additive (design.md Decision 2, spec §25 #1) — equals `recorded_at`. */
  created_at: number;
  /** Additive (design.md Decision 2, spec §25 #1) — equals `recorded_at`. */
  updated_at: number;

  quantity: number;
  price: number;
  notional_usdt: number;

  fee_usdt: number;
  fee_asset: string;

  liquidity: 'MAKER' | 'TAKER' | 'SIMULATED';

  slippage_from_reference_pct: number;
}
