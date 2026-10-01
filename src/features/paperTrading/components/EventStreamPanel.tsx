/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `EventStreamPanel` (tech spec §34, task 3.6). Shows
 * the live event feed (`usePaperEventStream`) as
 * `HH:mm:ss.SSS [CATEGORY] summary` plus the connection status. Receive-
 * only — this panel never sends anything over the WebSocket.
 */
import React from 'react';
import type { TradingEvent } from '../api/contracts';
import type { PaperEventStreamStatus, SeqEvent } from '../hooks/usePaperEventStream';
import { formatClockUtc } from '../format';
import { MockBadge } from './MockBadge';

export interface EventStreamPanelProps {
  events: SeqEvent[];
  status: PaperEventStreamStatus;
  mock?: boolean;
}

const CATEGORY_BY_PREFIX: Array<[RegExp, string]> = [
  [/^OPPORTUNITY_/, 'SCAN'],
  [/^RISK_/, 'RISK'],
  [/FILL/, 'FILL'],
  [/^ORDER_/, 'ORDER'],
  [/^POSITION_|^LEG_|^HEDGE_|^EMERGENCY_/, 'POSITION'],
  [/FUNDING/, 'FUNDING'],
];

function categoryFor(eventType: string): string {
  for (const [re, cat] of CATEGORY_BY_PREFIX) {
    if (re.test(eventType)) return cat;
  }
  return 'SYSTEM';
}

function summarize(event: TradingEvent): string {
  const parts: string[] = [event.exchange, event.symbol].filter((v): v is string => Boolean(v));
  const fillPct = event.payload?.fill_pct;
  if (typeof fillPct === 'number') parts.push(`${Math.round(fillPct * 100)}%`);
  return parts.join(' ');
}

export const EventStreamPanel: React.FC<EventStreamPanelProps> = ({ events, status, mock }) => {
  return (
    <section className="rounded border border-slate-800 bg-slate-950/60 p-4">
      <h3 className="mb-3 flex items-center justify-between font-mono text-sm font-semibold text-slate-200">
        <span className="flex items-center">
          Event Stream
          {mock && <MockBadge />}
        </span>
        <span
          className={`font-mono text-[10px] ${
            status === 'CONNECTED' ? 'text-emerald-400' : status === 'RECONNECTING' ? 'text-amber-400' : 'text-rose-400'
          }`}
        >
          {status}
        </span>
      </h3>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px] text-slate-300">
        {[...events]
          .slice()
          .reverse()
          .map((e) => (
            <li key={e.event_id}>
              {formatClockUtc(e.timestamp)} [{categoryFor(e.event_type)}] {e.event_type} {summarize(e)}
            </li>
          ))}
        {events.length === 0 && <li className="text-slate-500">No events yet</li>}
      </ul>
    </section>
  );
};
