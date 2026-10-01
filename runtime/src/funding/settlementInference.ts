// TODO(trading-schema-types): 合併後改為 import { PositionSide } from 'runtime/src/types'
export type PositionSide = 'LONG' | 'SHORT';

import type { FundingSettlementStatus } from '../types/status';
export type { FundingSettlementStatus };

export type MarkPriceSource = 'EXCHANGE' | 'SNAPSHOT';

export interface SettledRecord {
  rate: number;
  /** Public source's own mark price, when it has one (Binance does; Bybit does not). */
  markPrice?: number;
  publishedAt: number;
}

export interface FundingSettlementResult {
  status: FundingSettlementStatus;
  cashflowUsdt: number;
  markPriceSource?: MarkPriceSource;
  publicationDelayMs?: number;
  needsManualReview?: boolean;
}

/**
 * Signed cashflow for one leg (funding-settlement-rules spec "Funding settlement is inferred
 * from public settled rates"): positive rate -> LONG pays, SHORT receives.
 */
export function computeSettlementCashflow(input: {
  side: PositionSide;
  quantity: number;
  settledRate: number;
  markPrice: number;
}): number {
  const magnitude = input.markPrice * input.quantity * input.settledRate;
  const sign = input.side === 'LONG' ? -1 : 1;
  return sign * magnitude;
}

/**
 * Infers one leg's `FundingSettlement` from the public settled-rate source
 * (funding-settlement-rules spec "Funding settlement is inferred from public settled rates").
 */
export function resolveSettlement(input: {
  T: number;
  now: number;
  side: PositionSide;
  quantity: number;
  /** Whether this leg was continuously held through [hedged_by, lock_end]. */
  heldContinuously: boolean;
  settledRecord?: SettledRecord;
  /** Fallback mark price when the settled source doesn't carry one (e.g. Bybit). */
  marketSnapshotAtT?: { markPrice: number };
  settlementConfirmTimeoutMs: number;
}): FundingSettlementResult {
  if (!input.heldContinuously) {
    return { status: 'NOT_ELIGIBLE', cashflowUsdt: 0 };
  }

  if (input.settledRecord) {
    const markPrice = input.settledRecord.markPrice ?? input.marketSnapshotAtT?.markPrice;
    const markPriceSource: MarkPriceSource = input.settledRecord.markPrice !== undefined ? 'EXCHANGE' : 'SNAPSHOT';
    if (markPrice === undefined) {
      // No exchange mark price and no snapshot fallback: cannot compute cashflow yet.
      return { status: 'ELIGIBLE', cashflowUsdt: 0 };
    }
    const cashflowUsdt = computeSettlementCashflow({
      side: input.side,
      quantity: input.quantity,
      settledRate: input.settledRecord.rate,
      markPrice,
    });
    return {
      status: 'SETTLED',
      cashflowUsdt,
      markPriceSource,
      publicationDelayMs: input.settledRecord.publishedAt - input.T,
    };
  }

  if (input.now - input.T > input.settlementConfirmTimeoutMs) {
    return { status: 'MISSED', cashflowUsdt: 0, needsManualReview: true };
  }

  return { status: 'ELIGIBLE', cashflowUsdt: 0 };
}

export interface TradeFinalization {
  fundingConfirmed: boolean;
  finalizedAt: number | null;
}

const TERMINAL_STATUSES: FundingSettlementStatus[] = ['SETTLED', 'NOT_ELIGIBLE', 'MISSED'];

/**
 * funding-settlement-rules spec "PnL finalization after both legs settle": `finalized_at` is set
 * once every leg reaches a terminal status; `funding_confirmed` is true only when every leg
 * actually SETTLED (NOT_ELIGIBLE/MISSED legs mean the funding cashflow is not fully confirmed).
 */
export function finalizeTradeResult(legStatuses: FundingSettlementStatus[], now: number): TradeFinalization {
  const allTerminal = legStatuses.every((status) => TERMINAL_STATUSES.includes(status));
  if (!allTerminal) return { fundingConfirmed: false, finalizedAt: null };

  const allSettled = legStatuses.every((status) => status === 'SETTLED');
  return { fundingConfirmed: allSettled, finalizedAt: now };
}
