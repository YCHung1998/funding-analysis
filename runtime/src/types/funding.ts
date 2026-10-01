/**
 * runtime/src/types/funding.ts
 *
 * `FundingSettlement` — spec §18, verbatim field names, plus additive
 * event-loop fields `mark_price_source?`, `settled_rate_published_at?`,
 * `publication_delay_ms?` (design.md Decision 2 / spec.md requirement,
 * owned semantically by `funding-settlement-rules` in
 * `paper-trading-event-loop`).
 */
import type { ExchangeId } from './ids';
import type { FundingSettlementStatus } from './status';

export interface FundingSettlement {
  funding_id: string;
  trade_id: string;
  leg_id: string;

  exchange: ExchangeId;
  symbol: string;

  funding_time: number;
  position_notional: number;
  funding_rate: number;
  settled_funding_rate?: number;
  position_side: 'LONG' | 'SHORT';

  expected_cashflow_usdt: number;
  actual_cashflow_usdt?: number;

  settlement_status: FundingSettlementStatus;

  created_at: number;
  updated_at: number;
  settlement_timestamp?: number;

  /** Additive (design.md Decision 2) — owned by `funding-settlement-rules`. */
  mark_price_source?: 'SETTLEMENT_RECORD' | 'SNAPSHOT';
  /** Additive (design.md Decision 2) — owned by `funding-settlement-rules`. */
  settled_rate_published_at?: number;
  /** Additive (design.md Decision 2) — owned by `funding-settlement-rules`. */
  publication_delay_ms?: number;
}
