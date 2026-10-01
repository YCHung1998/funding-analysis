/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `FundingConfirmationBadge` (spec §27 資金費待入帳與定案顯示,
 * `paper-trading-event-loop` design Decision 6, task 3.3).
 *
 * This is the one place spec.md explicitly keeps Chinese display text
 * instead of an English status code (design.md Open Question 1) — it is a
 * finalization-semantics label, not an entity status-machine code, so it is
 * intentionally NOT routed through `StatusCode` / the glossary.
 */
import React from 'react';
import type { FundingSettlement, TradeResult } from '../api/contracts';

export interface FundingConfirmationBadgeProps {
  result: Pick<TradeResult, 'funding_confirmed' | 'finalized_at'>;
  legSettlements?: Pick<FundingSettlement, 'settlement_status'>[];
}

export const FundingConfirmationBadge: React.FC<FundingConfirmationBadgeProps> = ({
  result,
  legSettlements = [],
}) => {
  const finalized = result.funding_confirmed && result.finalized_at !== undefined;
  const missed = legSettlements.some((l) => l.settlement_status === 'MISSED');

  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px]">
      <span className={finalized ? 'text-emerald-400' : 'text-amber-400'}>
        {finalized ? '已定案' : '已平倉 · 待入帳'}
      </span>
      <span className="text-slate-500">（推定結算（依公開已結算費率））</span>
      {missed && <span className="font-semibold text-rose-400">需人工檢查</span>}
    </span>
  );
};
