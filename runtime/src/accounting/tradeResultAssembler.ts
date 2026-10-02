/**
 * runtime/src/accounting/tradeResultAssembler.ts
 *
 * `pnl-engine` capability: TradeResult assembly, provisional -> final
 * (position-funding-pnl design.md Decision 7/8; spec §21). Reuses
 * `funding/settlementInference.ts`'s `finalizeTradeResult` for the
 * `funding_confirmed`/`finalized_at` rule (same reasoning as
 * `fundingAmount.ts` task 3.2: that is `funding-settlement-rules`' single
 * source of truth, not reforked here).
 */
import type { ExchangeId } from '../types/ids';
import type { FundingSettlementStatus } from '../types/status';
import type { TradeResult } from '../types/result';
import { finalizeTradeResult } from '../funding/settlementInference';
import { aggregatePnl, roiOnCapital, roiOnNotional, type LegPnlInput } from './pnlEngine';

/** design.md Decision 7 "final_status：ABORTED/FAILED/EMERGENCY_EXIT 優先". `undefined` = classify by net vs. tolerance. */
export type TerminalOutcome = 'ABORTED' | 'FAILED' | 'EMERGENCY_EXIT';

export const DEFAULT_BREAK_EVEN_TOLERANCE_USDT = 0.01;

export interface AssembleTradeResultInput {
  trade_id: string;
  symbol: string;
  mode: 'PAPER' | 'BACKTEST';
  long_exchange: ExchangeId;
  short_exchange: ExchangeId;
  target_notional_per_leg_usdt: number;
  actual_long_notional_usdt: number;
  actual_short_notional_usdt: number;
  leverage: number;
  allocated_capital_usdt: number;

  entry_started_at?: number;
  entry_completed_at?: number;
  exit_started_at?: number;
  exit_completed_at?: number;

  legs: readonly LegPnlInput[];
  funding_settlement_statuses: readonly FundingSettlementStatus[];
  max_leg_imbalance_usdt: number;
  max_leg_imbalance_duration_ms: number;

  /** design.md Decision 7: ABORTED/FAILED/EMERGENCY_EXIT take priority over PROFIT/LOSS/BREAK_EVEN. */
  terminal_outcome?: TerminalOutcome;
  /** `Trade.close_reason === 'KILL_SWITCH'` still classifies by net (resolved Open Question 3), but result_reason stays 'KILL_SWITCH'. */
  close_reason?: 'NORMAL_EXIT' | 'EMERGENCY_EXIT' | 'KILL_SWITCH';
  break_even_tolerance_usdt?: number;

  /** First creation time (provisional TradeResult) — preserved across re-assembly on every settlement update. */
  created_at: number;
  /** Current clock time — becomes `updated_at`, and `finalized_at` once every leg reaches a terminal settlement status. */
  now: number;
}

function duration(start: number | undefined, end: number | undefined): number {
  if (start === undefined || end === undefined) return 0;
  return Math.max(0, end - start);
}

function classifyFinalStatus(
  netPnlUsdt: number,
  terminalOutcome: TerminalOutcome | undefined,
  toleranceUsdt: number,
): TradeResult['final_status'] {
  if (terminalOutcome) return terminalOutcome;
  if (Math.abs(netPnlUsdt) <= toleranceUsdt) return 'BREAK_EVEN';
  return netPnlUsdt > 0 ? 'PROFIT' : 'LOSS';
}

function resultReason(
  finalStatus: TradeResult['final_status'],
  terminalOutcome: TerminalOutcome | undefined,
  closeReason: AssembleTradeResultInput['close_reason'],
  hasMissed: boolean,
): string {
  const base = closeReason === 'KILL_SWITCH' ? 'KILL_SWITCH' : (terminalOutcome ?? finalStatus);
  return hasMissed ? `${base};FUNDING_MISSED_MANUAL_REVIEW` : base;
}

/**
 * Builds (or re-builds, on every settlement update) the full `TradeResult`
 * for one Trade (design.md Decision 7). Idempotent/pure: callers decide
 * whether to persist and whether to emit `TRADE_COMPLETED` (only once,
 * when `finalized_at` newly becomes set — see `shouldEmitTradeCompleted`).
 */
export function assembleTradeResult(input: AssembleTradeResultInput): TradeResult {
  const pnl = aggregatePnl(input.legs);
  const tolerance = input.break_even_tolerance_usdt ?? DEFAULT_BREAK_EVEN_TOLERANCE_USDT;
  const finalStatus = classifyFinalStatus(pnl.net_pnl_usdt, input.terminal_outcome, tolerance);
  const hasMissed = input.funding_settlement_statuses.includes('MISSED');
  const finalization = finalizeTradeResult([...input.funding_settlement_statuses], input.now);

  return {
    trade_id: input.trade_id,
    symbol: input.symbol,
    mode: input.mode,
    long_exchange: input.long_exchange,
    short_exchange: input.short_exchange,
    target_notional_per_leg_usdt: input.target_notional_per_leg_usdt,
    actual_long_notional_usdt: input.actual_long_notional_usdt,
    actual_short_notional_usdt: input.actual_short_notional_usdt,
    leverage: input.leverage,
    entry_duration_ms: duration(input.entry_started_at, input.entry_completed_at),
    exit_duration_ms: duration(input.exit_started_at, input.exit_completed_at),
    total_trade_duration_ms: duration(input.entry_started_at, input.exit_completed_at),
    funding_pnl_usdt: pnl.funding_pnl_usdt,
    price_pnl_usdt: pnl.price_pnl_usdt,
    fee_usdt: pnl.fee_usdt,
    slippage_attribution_usdt: pnl.slippage_attribution_usdt,
    net_pnl_usdt: pnl.net_pnl_usdt,
    roi_on_capital_pct: roiOnCapital(pnl.net_pnl_usdt, input.allocated_capital_usdt),
    roi_on_notional_pct: roiOnNotional(pnl.net_pnl_usdt, input.actual_long_notional_usdt, input.actual_short_notional_usdt),
    max_leg_imbalance_usdt: input.max_leg_imbalance_usdt,
    max_leg_imbalance_duration_ms: input.max_leg_imbalance_duration_ms,
    final_status: finalStatus,
    result_reason: resultReason(finalStatus, input.terminal_outcome, input.close_reason, hasMissed),
    finalized_at: finalization.finalizedAt ?? undefined,
    funding_confirmed: finalization.fundingConfirmed,
    created_at: input.created_at,
    updated_at: input.now,
  };
}

/**
 * design.md Decision 8: exactly one `TRADE_COMPLETED` event, emitted the
 * moment `finalized_at` newly becomes set (not on every provisional
 * re-assembly, and never again afterward — "定案後不再自動修改").
 */
export function shouldEmitTradeCompleted(previous: TradeResult | undefined, next: TradeResult): boolean {
  const wasFinalized = previous?.finalized_at !== undefined;
  const isFinalized = next.finalized_at !== undefined;
  return !wasFinalized && isFinalized;
}
