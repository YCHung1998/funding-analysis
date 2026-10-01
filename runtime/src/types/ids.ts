/**
 * runtime/src/types/ids.ts
 *
 * Single source of truth for exchange identifiers and ID-like string aliases
 * used across the v0.2 trading schema (spec §4–§21; capability `trading-schema`).
 *
 * Spec §5–§21 field names are reproduced verbatim; ID fields are plain
 * `string` at runtime, the aliases below only document intent for readers.
 */

/** The five exchanges the research scanner covers (spec §3, C-01). */
export const EXCHANGE_IDS = ['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'] as const;

export type ExchangeId = (typeof EXCHANGE_IDS)[number];

export type OpportunityId = string;
export type TradeId = string;
export type LegId = string;
export type OrderId = string;
export type ClientOrderId = string;
export type FillId = string;
export type FundingSettlementId = string;
export type RiskCheckId = string;
export type AccountSnapshotId = string;
export type PositionId = string;
export type EventId = string;
export type SessionId = string;

/**
 * Where a timestamp on an entity came from. `'UNKNOWN'` is reserved for
 * data imported from v0.1 history that never recorded real timestamps
 * (spec §2.1 rule 5) — such records MUST NOT be written as `PAPER` entities
 * (see `validate.ts` / `legacy/historicalImport.ts`).
 */
export type TimestampSource = 'EXCHANGE' | 'LOCAL' | 'SYSTEM' | 'UNKNOWN';
