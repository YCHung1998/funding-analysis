/**
 * runtime/src/types/opportunity.ts
 *
 * `Opportunity` — spec §5, verbatim field names, plus additive `created_at`
 * (design.md Decision 2: §25 #1 requires created_at/updated_at on every
 * persisted entity; spec §5 omits it, so it is added equal to `detected_at`
 * on creation).
 */
import type { ExchangeId } from './ids';
import type { OpportunityStatus } from './status';

export interface Opportunity {
  opportunity_id: string;
  symbol: string;

  /** Additive (design.md Decision 2, spec §25 #1) — equals `detected_at` on creation. */
  created_at: number;
  detected_at: number;
  expires_at: number;
  updated_at: number;

  long_exchange: ExchangeId;
  short_exchange: ExchangeId;

  long_funding_rate: number;
  short_funding_rate: number;
  funding_spread: number;

  long_funding_time: number;
  short_funding_time: number;
  long_funding_interval_hours: number;
  short_funding_interval_hours: number;
  funding_time_diff_ms: number;
  funding_aligned: boolean;

  long_price: number;
  short_price: number;
  price_difference_pct: number;

  estimated_fee_pct: number;
  estimated_slippage_pct: number;
  estimated_funding_pnl: number;
  estimated_net_pnl: number;

  liquidity_score: number;
  strategy_version: string;

  status: OpportunityStatus;
  rejection_reason?: string;
}
