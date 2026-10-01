/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `PnlWaterfall` (spec §20.1, C-13, task 3.5).
 * Funding -> Price (Slippage as an indented sub-item) -> Fees -> Net. The
 * Net bar always equals the API's `net_pnl_usdt`; Slippage is informational
 * only and MUST NOT be added into any bar's height here.
 */
import React from 'react';
import type { TradeResult } from '../api/contracts';
import { formatSignedUsdt, formatUsdt } from '../format';
import { SlippageAttribution } from './SlippageAttribution';

export interface PnlWaterfallProps {
  result: Pick<TradeResult, 'funding_pnl_usdt' | 'price_pnl_usdt' | 'fee_usdt' | 'slippage_attribution_usdt' | 'net_pnl_usdt'>;
}

export const PnlWaterfall: React.FC<PnlWaterfallProps> = ({ result }) => {
  const maxAbs = Math.max(
    Math.abs(result.funding_pnl_usdt),
    Math.abs(result.price_pnl_usdt),
    Math.abs(result.fee_usdt),
    Math.abs(result.net_pnl_usdt),
    1,
  );
  const barWidth = (v: number) => `${Math.min(100, (Math.abs(v) / maxAbs) * 100)}%`;

  return (
    <div className="space-y-1.5" data-testid="pnl-waterfall">
      <Bar label="Funding" value={result.funding_pnl_usdt} width={barWidth(result.funding_pnl_usdt)} />
      <Bar label="Price" value={result.price_pnl_usdt} width={barWidth(result.price_pnl_usdt)}>
        <div className="ml-4 flex items-center gap-1 text-[10px]">
          <span className="text-slate-500">Slippage</span>
          <SlippageAttribution amountUsdt={result.slippage_attribution_usdt} />
        </div>
      </Bar>
      <Bar label="Fees" value={-Math.abs(result.fee_usdt)} width={barWidth(result.fee_usdt)} />
      <Bar label="Net" value={result.net_pnl_usdt} width={barWidth(result.net_pnl_usdt)} bold />
    </div>
  );
};

const Bar: React.FC<{ label: string; value: number; width: string; bold?: boolean; children?: React.ReactNode }> = ({
  label,
  value,
  width,
  bold,
  children,
}) => (
  <div>
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-16 text-slate-400 ${bold ? 'font-semibold text-slate-200' : ''}`}>{label}</span>
      <div className="h-3 flex-1 rounded bg-slate-900">
        <div
          className={`h-3 rounded ${value >= 0 ? 'bg-emerald-600' : 'bg-rose-600'}`}
          style={{ width }}
        />
      </div>
      <span className={`w-20 text-right font-mono ${value >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        {label === 'Fees' ? `-${formatUsdt(Math.abs(value))}` : formatSignedUsdt(value)}
      </span>
    </div>
    {children}
  </div>
);
