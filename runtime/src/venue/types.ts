// TODO(trading-schema-types): 合併後改為 import { ExchangeId } from 'runtime/src/types'
export type ExchangeId = 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';

/**
 * Settlement rule for one exchange, provided by that exchange's adapter
 * (funding-settlement-rules spec "Venue settlement rules provided by adapters").
 * This is DATA, not a branch point — strategy/session code reads these values instead of
 * switching on `exchange` (HANDOFF Invariant 3).
 */
export interface VenueRule {
  exchange: ExchangeId;
  /** Uncertainty window before T within which a position's inclusion is not guaranteed. */
  guardBeforeMs: number;
  /** Uncertainty window after T within which a position's inclusion is not guaranteed. */
  guardAfterMs: number;
  /** Where the publicly-settled funding rate for a past T is read from (adapter-defined id/description). */
  settledRateSource: string;
  /** Where the current funding interval is read from (adapter-defined id/description). */
  fundingIntervalSource: string;
}

export interface PairGuard {
  guardBeforeMs: number;
  guardAfterMs: number;
}
