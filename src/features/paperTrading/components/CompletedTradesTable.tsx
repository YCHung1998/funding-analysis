/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `CompletedTradesTable` (spec §27, task 3.3).
 * Presentational: the caller (`PaperTradingTab`) owns the filter/cursor
 * state and server-side pagination request; this component only renders
 * whatever page it was given and never grows the DOM beyond that page
 * (FE-04 — "any time the DOM rows MUST NOT exceed one page").
 */
import React from 'react';
import type { CompletedFinalStatusFilter, CompletedTradeSummary } from '../api/contracts';
import { formatUsdt } from '../format';
import { FundingConfirmationBadge } from './FundingConfirmationBadge';
import { MockBadge } from './MockBadge';
import { SlippageAttribution } from './SlippageAttribution';
import { StatusCode } from './StatusCode';

export interface CompletedTradesTableProps {
  items: CompletedTradeSummary[];
  filter: CompletedFinalStatusFilter;
  onFilterChange: (filter: CompletedFinalStatusFilter) => void;
  hasNextPage: boolean;
  onLoadNextPage: () => void;
  onSelect: (tradeId: string) => void;
  mock?: boolean;
}

const FILTERS: CompletedFinalStatusFilter[] = [
  'ALL',
  'PROFIT',
  'LOSS',
  'BREAK_EVEN',
  'ABORTED',
  'FAILED',
  'EMERGENCY_EXIT',
];

export const CompletedTradesTable: React.FC<CompletedTradesTableProps> = ({
  items,
  filter,
  onFilterChange,
  hasNextPage,
  onLoadNextPage,
  onSelect,
  mock,
}) => {
  return (
    <section className="rounded border border-slate-800 bg-slate-950/60 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center font-mono text-sm font-semibold text-slate-200">
          Completed Trades
          {mock && <MockBadge />}
        </h3>
        <label className="flex items-center gap-1 text-xs text-slate-400">
          Result
          <select
            value={filter}
            onChange={(e) => onFilterChange(e.target.value as CompletedFinalStatusFilter)}
            className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200"
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 pr-2">Trade Time</th>
              <th className="py-1 pr-2">Symbol</th>
              <th className="py-1 pr-2">Entry</th>
              <th className="py-1 pr-2">Exit</th>
              <th className="py-1 pr-2">Funding</th>
              <th className="py-1 pr-2">Fees</th>
              <th className="py-1 pr-2">Slippage</th>
              <th className="py-1 pr-2">Net PnL</th>
              <th className="py-1 pr-2">Duration</th>
              <th className="py-1 pr-2">Result</th>
              <th className="py-1 pr-2">Funding Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr
                key={t.trade_id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(t.trade_id)}
                className="cursor-pointer border-t border-slate-900 hover:bg-slate-900/60"
              >
                <td className="py-1 pr-2 font-mono">{new Date(t.created_at).toISOString()}</td>
                <td className="py-1 pr-2">{t.symbol}</td>
                <td className="py-1 pr-2 font-mono">{formatUsdt(t.result.actual_long_notional_usdt)}</td>
                <td className="py-1 pr-2 font-mono">{formatUsdt(t.result.actual_short_notional_usdt)}</td>
                <td className="py-1 pr-2 font-mono">{formatUsdt(t.result.funding_pnl_usdt)}</td>
                <td className="py-1 pr-2 font-mono">{formatUsdt(t.result.fee_usdt)}</td>
                <td className="py-1 pr-2">
                  <SlippageAttribution amountUsdt={t.result.slippage_attribution_usdt} />
                </td>
                <td className="py-1 pr-2 font-mono">{formatUsdt(t.result.net_pnl_usdt)}</td>
                <td className="py-1 pr-2 font-mono">{t.result.total_trade_duration_ms}ms</td>
                <td className="py-1 pr-2">
                  <div className="flex flex-col gap-0.5">
                    <StatusCode code={t.result.final_status} category="TRADE" />
                    {t.result.result_reason && (
                      <span className="text-[10px] text-slate-500">{t.result.result_reason}</span>
                    )}
                  </div>
                </td>
                <td className="py-1 pr-2">
                  {t.status === 'CLOSED' && <FundingConfirmationBadge result={t.result} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="py-4 text-center text-slate-500">No completed trades</div>}
      </div>
      {hasNextPage && (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={onLoadNextPage}
            className="rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
          >
            載入下一頁
          </button>
        </div>
      )}
    </section>
  );
};
