/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `TradeDetail` (spec §28, task 3.4). Presentational:
 * receives an already-fetched `TradeDetailResponse`. Race-safety for rapid
 * trade switching lives in the caller's `useAbortableQuery(['trade', id])`
 * — see PaperTradingTab.tsx — not in this component.
 *
 * GAP vs spec §28: `FundingSettlement` (runtime/src/types/funding.ts) has
 * no `interval_hours` field of its own. The interval shown per leg is
 * sourced from `opportunity.long_funding_interval_hours` /
 * `short_funding_interval_hours` matched by exchange, which is the closest
 * available data. "Slippage 歸因" at the Entry-leg level is shown as the
 * order's `actual_slippage_pct` (a percentage) rather than a USDT
 * attribution — `PaperOrder` has no slippage-in-USDT field; the USDT
 * attribution (`SlippageAttribution`) is used in the Result section where
 * `slippage_attribution_usdt` actually exists.
 */
import React from 'react';
import type { TradeDetailResponse } from '../api/contracts';
import { EMPTY_VALUE, formatClockUtc, formatNumber, formatRatePct, formatUsdt } from '../format';
import { FundingConfirmationBadge } from './FundingConfirmationBadge';
import { PnlWaterfall } from './PnlWaterfall';
import { SlippageAttribution } from './SlippageAttribution';
import { StatusCode } from './StatusCode';
import { TradeTimeline, type SeqEvent } from './TradeTimeline';

export interface TradeDetailProps {
  detail: TradeDetailResponse;
  events: SeqEvent[];
  onClose: () => void;
  onLoadMoreEvents?: () => void;
  hasMoreEvents?: boolean;
}

function fmt(v: number | undefined | null): string {
  return v === undefined || v === null ? EMPTY_VALUE : formatUsdt(v);
}

export const TradeDetail: React.FC<TradeDetailProps> = ({
  detail,
  events,
  onClose,
  onLoadMoreEvents,
  hasMoreEvents,
}) => {
  const { trade, legs, orders, opportunity, result } = detail;
  const longLeg = legs.find((l) => l.direction === 'LONG');
  const shortLeg = legs.find((l) => l.direction === 'SHORT');
  const grossNotional =
    (longLeg?.actual_notional_usdt ?? 0) + (shortLeg?.actual_notional_usdt ?? 0) || undefined;

  const ordersFor = (legId: string | undefined, purpose: 'ENTRY' | 'EXIT') =>
    orders.find((o) => o.leg_id === legId && o.purpose === purpose);

  return (
    <section className="rounded border border-slate-800 bg-slate-950/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold text-slate-200">TRADE #{trade.trade_id}</h3>
        <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-200">
          Close
        </button>
      </div>

      {/* Strategy */}
      <DetailSection title="Strategy">
        <Field label="Strategy Version" value={trade.strategy_version} />
        <Field label="Config Version" value={trade.config_version} />
        <Field label="Opportunity ID" value={opportunity.opportunity_id} />
        <Field label="Detection Time" value={formatClockUtc(opportunity.detected_at)} />
        <Field label="Funding Spread" value={formatRatePct(opportunity.funding_spread)} />
        <Field label="Expected PnL" value={fmt(trade.expected_pnl_usdt)} />
      </DetailSection>

      {/* Position */}
      <DetailSection title="Position">
        <Field label="Long Exchange" value={longLeg?.exchange ?? EMPTY_VALUE} />
        <Field label="Short Exchange" value={shortLeg?.exchange ?? EMPTY_VALUE} />
        <Field label="Leverage" value={`${trade.leverage}x`} />
        <Field label="Target Notional/Leg" value={formatNumber(trade.target_notional_per_leg_usdt)} />
        <Field label="Long Notional" value={fmt(longLeg?.actual_notional_usdt)} />
        <Field label="Short Notional" value={fmt(shortLeg?.actual_notional_usdt)} />
        <Field label="Gross" value={fmt(grossNotional)} />
        <Field label="Margin" value={fmt(trade.allocated_margin_usdt)} />
        <Field label="Capital Allocation" value={fmt(trade.allocated_capital_usdt)} />
      </DetailSection>

      {/* Entry */}
      <DetailSection title="Entry">
        {[longLeg, shortLeg].filter(Boolean).map((leg) => {
          const order = ordersFor(leg!.leg_id, 'ENTRY');
          return (
            <div key={leg!.leg_id} className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
              <Field label={`${leg!.direction} Order Time`} value={formatClockUtc(order?.submit_time)} />
              <Field label={`${leg!.direction} ACK Time`} value={formatClockUtc(order?.ack_time)} />
              <Field label={`${leg!.direction} Fill Time`} value={formatClockUtc(order?.final_fill_time)} />
              <Field label={`${leg!.direction} Target Price`} value={fmt(leg!.target_entry_price)} />
              <Field label={`${leg!.direction} Average Fill`} value={fmt(leg!.average_entry_price)} />
              <Field
                label={`${leg!.direction} Slippage`}
                value={order?.actual_slippage_pct !== undefined ? formatRatePct(order.actual_slippage_pct) : EMPTY_VALUE}
              />
            </div>
          );
        })}
      </DetailSection>

      {/* Funding */}
      <DetailSection title="Funding">
        {detail.funding_settlements.length === 0 && <div className="text-slate-500">{EMPTY_VALUE}</div>}
        {detail.funding_settlements.map((f) => {
          const interval =
            f.exchange === opportunity.long_exchange
              ? opportunity.long_funding_interval_hours
              : opportunity.short_funding_interval_hours;
          return (
            <div key={f.funding_id} className="mb-1.5 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
              <Field label={`${f.exchange} Funding Time`} value={formatClockUtc(f.funding_time)} />
              <Field label={`${f.exchange} Interval`} value={interval ? `${interval}h` : EMPTY_VALUE} />
              <Field label={`${f.exchange} Rate`} value={formatRatePct(f.funding_rate)} />
              <div>
                <div className="text-slate-500">{f.exchange} Status</div>
                <StatusCode code={f.settlement_status} category="FUNDING" />
              </div>
            </div>
          );
        })}
      </DetailSection>

      {/* Exit */}
      <DetailSection title="Exit">
        {[longLeg, shortLeg].filter(Boolean).map((leg) => {
          const order = ordersFor(leg!.leg_id, 'EXIT');
          return (
            <div key={leg!.leg_id} className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
              <Field label={`${leg!.direction} Exit Order Time`} value={formatClockUtc(order?.submit_time)} />
              <Field label={`${leg!.direction} Exit Fill Time`} value={formatClockUtc(order?.final_fill_time)} />
              <Field label={`${leg!.direction} Exit Price`} value={fmt(leg!.average_exit_price)} />
            </div>
          );
        })}
      </DetailSection>

      {/* Result */}
      <DetailSection title="Result">
        {result ? (
          <>
            <Field label="Funding PnL" value={fmt(result.funding_pnl_usdt)} />
            <Field label="Price PnL" value={fmt(result.price_pnl_usdt)} />
            <Field label="Fee" value={fmt(result.fee_usdt)} />
            <Field label="Net PnL" value={fmt(result.net_pnl_usdt)} />
            <Field label="ROI on Capital" value={formatRatePct(result.roi_on_capital_pct)} />
            <Field label="ROI on Notional" value={formatRatePct(result.roi_on_notional_pct)} />
            <div>
              <div className="text-slate-500">Slippage</div>
              <SlippageAttribution amountUsdt={result.slippage_attribution_usdt} />
            </div>
            <div>
              <div className="text-slate-500">Final Status</div>
              <StatusCode code={result.final_status} category="TRADE" />
            </div>
            <Field label="Result Reason" value={result.result_reason} />
            {trade.status === 'CLOSED' && (
              <div className="col-span-full">
                <FundingConfirmationBadge result={result} legSettlements={detail.funding_settlements} />
              </div>
            )}
            <div className="col-span-full mt-2">
              <PnlWaterfall result={result} />
            </div>
          </>
        ) : (
          <div className="text-slate-500">{EMPTY_VALUE}</div>
        )}
      </DetailSection>

      <TradeTimeline events={events} tradeCreatedAt={trade.created_at} onLoadMore={onLoadMoreEvents} hasMore={hasMoreEvents} />
    </section>
  );
};

const DetailSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="mb-4 border-t border-slate-900 pt-3">
    <h4 className="mb-2 font-mono text-xs font-semibold text-cyan-300">{title}</h4>
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">{children}</div>
  </div>
);

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-slate-500">{label}</div>
    <div className="font-mono text-slate-100">{value}</div>
  </div>
);
