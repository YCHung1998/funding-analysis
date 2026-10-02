/**
 * runtime/src/trading/fundingAmount.ts
 *
 * `pnl-engine` capability: FundingSettlement **amount** hook, called by
 * `funding-settlement-rules`'s state machine (`paper-trading-event-loop`)
 * on every `settlement_status` transition (position-funding-pnl design.md
 * Decision 6; tasks.md 3.1). This change only computes *how much*; it never
 * decides *when* — the state, lock windows and timeouts are entirely
 * `funding-settlement-rules`'s (this file does not import that state
 * machine, only its status literals as a lookup key).
 *
 * Signature pin (tasks.md 3.1 / CONTRACT_MEMO.md §1 reconstruction,
 * formalized here as the first sub-step of task 3.1): the state machine
 * passes the fields it already has for that transition (target or actual
 * quantity, current or settled mark price, predicted or settled rate) and
 * gets back exactly the fields Decision 6's table says to write for that
 * state — nothing more, so the caller can spread the result straight into
 * the same `FundingSettlement` write / event payload.
 */
import { fundingCashflow, type PositionSide } from '../accounting/fundingMath';

export type { PositionSide };

export type FundingSettlementState = 'EXPECTED' | 'ELIGIBLE' | 'SETTLED' | 'NOT_ELIGIBLE' | 'MISSED';

export interface FundingAmountInput {
  side: PositionSide;
  /** `target_quantity` (EXPECTED) | `base_quantity` at `lock_end` (ELIGIBLE) | `qty_at_T` (SETTLED). Ignored for NOT_ELIGIBLE/MISSED. */
  quantity: number;
  /** Current mark (EXPECTED/ELIGIBLE) or mark at T (SETTLED). Ignored for NOT_ELIGIBLE/MISSED. */
  mark_price: number;
  /** Predicted rate (EXPECTED/ELIGIBLE) or settled rate (SETTLED). Ignored for NOT_ELIGIBLE/MISSED. */
  funding_rate: number;
}

export interface FundingAmountResult {
  expected_cashflow_usdt?: number;
  /** Absent for MISSED (design.md Decision 6 "MISSED：不寫 actual_cashflow_usdt（空值）"). */
  actual_cashflow_usdt?: number;
  position_notional?: number;
  settled_funding_rate?: number;
  /** SETTLED only: `FundingSettlement.funding_rate` must be overwritten with this (spec §18 Q-04). */
  funding_rate?: number;
}

/**
 * Computes the fields `funding-settlement-rules` should write for one
 * `settlement_status` transition (design.md Decision 6 table). All amounts
 * go through `cost-model.fundingCashflow` — never a forked formula (Q-07).
 */
export function fundingAmount(state: FundingSettlementState, input: FundingAmountInput): FundingAmountResult {
  switch (state) {
    case 'EXPECTED': {
      const cashflow = fundingCashflow({ side: input.side, baseQuantity: input.quantity, markPrice: input.mark_price, rate: input.funding_rate });
      return { expected_cashflow_usdt: cashflow };
    }
    case 'ELIGIBLE': {
      // Recomputed with the actual base_quantity at lock_end, current mark, latest predicted rate.
      const cashflow = fundingCashflow({ side: input.side, baseQuantity: input.quantity, markPrice: input.mark_price, rate: input.funding_rate });
      return { expected_cashflow_usdt: cashflow };
    }
    case 'SETTLED': {
      const cashflow = fundingCashflow({ side: input.side, baseQuantity: input.quantity, markPrice: input.mark_price, rate: input.funding_rate });
      return {
        actual_cashflow_usdt: cashflow,
        position_notional: input.mark_price * input.quantity,
        settled_funding_rate: input.funding_rate,
        funding_rate: input.funding_rate,
      };
    }
    case 'NOT_ELIGIBLE':
      return { actual_cashflow_usdt: 0 };
    case 'MISSED':
      return {};
  }
}
