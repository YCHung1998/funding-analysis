/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `TradeTimeline` (spec §24, task 3.5). Shows every
 * `TradingEvent` for a trade (including timeout/cancel/reject events),
 * sorted by `(timestamp, seq)`, with absolute time, offset from the
 * trade's `created_at`, and `recorded_at` shown separately when it differs
 * from `timestamp` (spec.md "`recorded_at` 與 `timestamp` 不同時 SHALL 同時顯示").
 */
import React from 'react';
import type { TradingEvent } from '../api/contracts';
import { formatClockUtc, formatRelativeOffsetMs } from '../format';
import { StatusCode } from './StatusCode';

export type SeqEvent = TradingEvent & { seq: number };

export interface TradeTimelineProps {
  events: SeqEvent[];
  tradeCreatedAt: number;
  onLoadMore?: () => void;
  hasMore?: boolean;
}

function sortEvents(events: SeqEvent[]): SeqEvent[] {
  return [...events].sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
}

function summarizePayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
}

export const TradeTimeline: React.FC<TradeTimelineProps> = ({ events, tradeCreatedAt, onLoadMore, hasMore }) => {
  const sorted = sortEvents(events);

  return (
    <div className="mt-4 border-t border-slate-900 pt-3">
      <h4 className="mb-2 font-mono text-xs font-semibold text-cyan-300">Timeline</h4>
      <ol className="space-y-1 text-[11px]">
        {sorted.map((e) => (
          <li key={e.event_id} className="flex flex-wrap items-baseline gap-2 border-b border-slate-900/60 py-1">
            <span className="font-mono text-slate-400">{formatClockUtc(e.timestamp)}</span>
            <span className="font-mono text-slate-600">{formatRelativeOffsetMs(e.timestamp, tradeCreatedAt)}</span>
            <StatusCode code={e.event_type} category="EVENT" />
            {e.leg_id && <span className="text-slate-500">leg={e.leg_id}</span>}
            {e.order_id && <span className="text-slate-500">order={e.order_id}</span>}
            {e.exchange && <span className="text-slate-500">{e.exchange}</span>}
            {e.recorded_at !== e.timestamp && (
              <span className="text-amber-500">recorded_at={formatClockUtc(e.recorded_at)}</span>
            )}
            {summarizePayload(e.payload) && <span className="text-slate-500">{summarizePayload(e.payload)}</span>}
          </li>
        ))}
        {sorted.length === 0 && <li className="text-slate-500">No events</li>}
      </ol>
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          className="mt-2 rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          載入更多
        </button>
      )}
    </div>
  );
};
