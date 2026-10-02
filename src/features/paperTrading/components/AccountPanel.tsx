/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `AccountPanel` (spec §27 Account 區, task 3.1).
 * Presentational: receives the already-fetched `AccountSnapshot` (or an
 * error) as props; all fetching/polling lives in `PaperTradingTab`. Values
 * are displayed as-is — this component performs no financial computation.
 *
 * GAP vs spec §27 / design.md assumption A-5: the *actual* (already merged)
 * `runtime/src/types/account.ts` `AccountSnapshot` does not have
 * `allocated_capital_usdt`, `current_positions`, `max_positions`, or
 * `snapshot_at` — it has `reserved_capital_usdt`, `used_margin_usdt`,
 * `open_trade_count` and `snapshot_time` instead. This panel maps to the
 * fields that actually exist (`reserved_capital_usdt` as the closest
 * analogue to "Allocated Capital", `open_trade_count` as "Current
 * Positions") and renders "Max Positions" as the em dash — there is no
 * upstream field for it. See the final report's open-questions section.
 */
import React from 'react';
import type { AccountSnapshot } from '../api/contracts';
import { formatUsdt } from '../format';
import { MockBadge } from './MockBadge';

export interface AccountPanelProps {
  account: AccountSnapshot | undefined;
  error: Error | undefined;
  nowMs: number;
  staleAfterMs?: number;
  mock?: boolean;
}

export const AccountPanel: React.FC<AccountPanelProps> = ({
  account,
  error,
  nowMs,
  staleAfterMs = 10_000,
  mock,
}) => {
  const stale = account ? nowMs - account.snapshot_time > staleAfterMs : false;

  return (
    <section className="rounded border border-slate-800 bg-slate-950/60 p-4">
      <h3 className="mb-3 flex items-center font-mono text-sm font-semibold text-slate-200">
        Account
        {mock && <MockBadge />}
        {stale && (
          <span className="ml-2 rounded border border-amber-600/60 bg-amber-950/60 px-1.5 py-0.5 font-mono text-[10px] text-amber-400">
            STALE
          </span>
        )}
      </h3>
      {!account && (
        <div className="text-xs text-slate-500">{error ? 'RUNTIME_UNREACHABLE' : 'Loading…'}</div>
      )}
      {account && (
        <dl className={`grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 ${stale ? 'opacity-50' : ''}`}>
          <Metric label="Total Capital" value={formatUsdt(account.total_capital_usdt)} />
          <Metric label="Available Capital" value={formatUsdt(account.available_capital_usdt)} />
          <Metric label="Allocated Capital" value={formatUsdt(account.reserved_capital_usdt)} />
          <Metric label="Current Positions" value={`${account.open_trade_count}`} />
          <Metric label="Max Positions" value="—" />
          <Metric label="Updated" value={new Date(account.snapshot_time).toISOString()} />
        </dl>
      )}
    </section>
  );
};

const Metric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <dt className="text-slate-500">{label}</dt>
    <dd className="font-mono text-slate-100">{value}</dd>
  </div>
);
