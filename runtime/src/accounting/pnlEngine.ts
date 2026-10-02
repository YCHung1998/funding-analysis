/**
 * runtime/src/accounting/pnlEngine.ts
 *
 * `pnl-engine` capability: cross-leg PnL aggregation (position-funding-pnl
 * design.md Decision 7; spec §20-21). Pure aggregation over whatever Legs a
 * Trade has (1 or 2 — the single-leg EMERGENCY_EXIT case naturally falls
 * out of summing an array, Q-08). All composition goes through
 * `cost-model.composeNetPnl` — slippage is never subtracted a second time
 * (Q-05: it is already inside `realized_price_pnl_usdt`).
 */
import { composeNetPnl } from './pnlFormula';
import type { FundingSettlementStatus } from '../types/status';

export interface LegPnlInput {
  realized_price_pnl_usdt: number;
  fees_usdt: number;
  slippage_attribution_usdt: number;
  /** `undefined` = leg never got a FundingSettlement at all (treated like NOT_ELIGIBLE/MISSED -> 0, Q-08). */
  funding_settlement_status?: FundingSettlementStatus;
  expected_cashflow_usdt?: number;
  actual_cashflow_usdt?: number;
}

/**
 * Single-leg funding PnL rule (design.md Decision 7 / Q-08): SETTLED ->
 * actual cashflow; EXPECTED/ELIGIBLE (still provisional) -> expected
 * cashflow; NOT_ELIGIBLE / MISSED / no settlement at all -> 0. A failed
 * leg's missing FundingSettlement therefore contributes exactly 0, never
 * borrowing the other leg's cashflow.
 */
export function legFundingPnl(leg: Pick<LegPnlInput, 'funding_settlement_status' | 'expected_cashflow_usdt' | 'actual_cashflow_usdt'>): number {
  switch (leg.funding_settlement_status) {
    case 'SETTLED':
      return leg.actual_cashflow_usdt ?? 0;
    case 'EXPECTED':
    case 'ELIGIBLE':
      return leg.expected_cashflow_usdt ?? 0;
    case 'NOT_ELIGIBLE':
    case 'MISSED':
    default:
      return 0;
  }
}

export interface PnlAggregate {
  price_pnl_usdt: number;
  fee_usdt: number;
  slippage_attribution_usdt: number;
  funding_pnl_usdt: number;
  net_pnl_usdt: number;
}

/**
 * `price_pnl = Sigma legs realized_price_pnl_usdt`, `fee = Sigma legs fees_usdt`,
 * `slippage_attribution = Sigma legs slippage_attribution_usdt` (attribution only, already
 * inside price_pnl), `funding_pnl = Sigma legs legFundingPnl(leg)`,
 * `net_pnl = composeNetPnl(funding, price, fee, 0)` (design.md Decision 7).
 */
export function aggregatePnl(legs: readonly LegPnlInput[]): PnlAggregate {
  const price_pnl_usdt = legs.reduce((sum, leg) => sum + leg.realized_price_pnl_usdt, 0);
  const fee_usdt = legs.reduce((sum, leg) => sum + leg.fees_usdt, 0);
  const slippage_attribution_usdt = legs.reduce((sum, leg) => sum + leg.slippage_attribution_usdt, 0);
  const funding_pnl_usdt = legs.reduce((sum, leg) => sum + legFundingPnl(leg), 0);
  const net_pnl_usdt = composeNetPnl({ funding_pnl: funding_pnl_usdt, price_pnl: price_pnl_usdt, fees: fee_usdt, other_costs: 0 });
  return { price_pnl_usdt, fee_usdt, slippage_attribution_usdt, funding_pnl_usdt, net_pnl_usdt };
}

/** `net / (actual_long_notional + actual_short_notional) x 100`; denominator 0 -> 0 (✅ C-17). */
export function roiOnNotional(netPnlUsdt: number, actualLongNotionalUsdt: number, actualShortNotionalUsdt: number): number {
  const denominator = actualLongNotionalUsdt + actualShortNotionalUsdt;
  if (denominator <= 0) return 0;
  return (netPnlUsdt / denominator) * 100;
}

/** `net / allocated_capital_usdt x 100`; denominator 0 -> 0. */
export function roiOnCapital(netPnlUsdt: number, allocatedCapitalUsdt: number): number {
  if (allocatedCapitalUsdt <= 0) return 0;
  return (netPnlUsdt / allocatedCapitalUsdt) * 100;
}
