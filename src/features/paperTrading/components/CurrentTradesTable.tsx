/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `CurrentTradesTable` (spec §27, task 3.2).
 * Presentational: receives the already-fetched current-trade summaries.
 * Warning statuses (LEG_IMBALANCE, EMERGENCY_EXIT) sort first, then
 * created_at descending (design.md Decision 6). Clicking a row only
 * notifies the caller — it never fetches on its own.
 */
import React, { useMemo } from 'react';
import type { CurrentTradeSummary } from '../api/contracts';
import { formatNumber, formatRatioPct, formatUsdt } from '../format';
import { MockBadge } from './MockBadge';
import { StatusCode } from './StatusCode';

export interface CurrentTradesTableProps {
  trades: CurrentTradeSummary[];
  onSelect: (tradeId: string) => void;
  mock?: boolean;
}

const WARNING_STATUSES = new Set(['LEG_IMBALANCE', 'EMERGENCY_EXIT']);

function sortTrades(trades: CurrentTradeSummary[]): CurrentTradeSummary[] {
  return [...trades].sort((a, b) => {
    const aWarn = WARNING_STATUSES.has(a.status) ? 0 : 1;
    const bWarn = WARNING_STATUSES.has(b.status) ? 0 : 1;
    if (aWarn !== bWarn) return aWarn - bWarn;
    return b.created_at - a.created_at;
  });
}

export const CurrentTradesTable: React.FC<CurrentTradesTableProps> = ({ trades, onSelect, mock }) => {
  const sorted = useMemo(() => sortTrades(trades), [trades]);

  return (
    <section className="rounded border border-slate-800 bg-slate-950/60 p-4">
      <h3 className="mb-3 flex items-center font-mono text-sm font-semibold text-slate-200">
        Current Trades
        {mock && <MockBadge />}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 pr-2">Trade ID</th>
              <th className="py-1 pr-2">Symbol</th>
              <th className="py-1 pr-2">Long</th>
              <th className="py-1 pr-2">Short</th>
              <th className="py-1 pr-2">Notional/Leg</th>
              <th className="py-1 pr-2">Leverage</th>
              <th className="py-1 pr-2">Status</th>
              <th className="py-1 pr-2">Hedge Ratio</th>
              <th className="py-1 pr-2">Unrealized PnL</th>
              <th className="py-1 pr-2">Funding Expected</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => {
              const warn = WARNING_STATUSES.has(t.status);
              return (
                <tr
                  key={t.trade_id}
                  onClick={() => onSelect(t.trade_id)}
                  role="button"
                  tabIndex={0}
                  className={`cursor-pointer border-t border-slate-900 hover:bg-slate-900/60 ${
                    warn ? 'bg-rose-950/30' : ''
                  }`}
                >
                  <td className="py-1 pr-2 font-mono">{t.trade_id}</td>
                  <td className="py-1 pr-2">{t.symbol}</td>
                  <td className="py-1 pr-2">{t.long_exchange}</td>
                  <td className="py-1 pr-2">{t.short_exchange}</td>
                  <td className="py-1 pr-2 font-mono">{formatNumber(t.target_notional_per_leg_usdt)}</td>
                  <td className="py-1 pr-2 font-mono">{t.leverage}x</td>
                  <td className="py-1 pr-2">
                    <StatusCode code={t.status} category="TRADE" />
                  </td>
                  <td className="py-1 pr-2 font-mono">{formatRatioPct(t.hedge_ratio)}</td>
                  <td className="py-1 pr-2 font-mono">{formatUsdt(t.unrealized_pnl_usdt)}</td>
                  <td className="py-1 pr-2 font-mono">{formatUsdt(t.funding_expected_usdt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="py-4 text-center text-slate-500">No current trades</div>}
      </div>
    </section>
  );
};
