/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — root tab component (design.md Decision 1). Default
 * export so `App.tsx` can `React.lazy(() => import('./PaperTradingTab'))`.
 * Owns ALL data fetching/polling for this feature; every panel below it is
 * presentational (props in, no own fetching) — see each component's file
 * header. This file is the only place that talks to `getPaperDataSource()`.
 */
import React, { useEffect, useState } from 'react';
import { getPaperDataSource } from './api/dataSource';
import type { CompletedFinalStatusFilter } from './api/contracts';
import { useAbortableQuery } from './hooks/useAbortableQuery';
import { usePaperEventStream } from './hooks/usePaperEventStream';
import { AccountPanel } from './components/AccountPanel';
import { RuntimeHealthPanel } from './components/RuntimeHealthPanel';
import { CurrentTradesTable } from './components/CurrentTradesTable';
import { CompletedTradesTable } from './components/CompletedTradesTable';
import { TradeDetail } from './components/TradeDetail';
import { EventStreamPanel } from './components/EventStreamPanel';
import { KillSwitchPlaceholder } from './components/KillSwitchPlaceholder';
import { MockDataBanner } from './components/MockBadge';
import { FIXTURE_GLOBAL_EVENTS } from './api/mock/fixtures';

const ACCOUNT_POLL_MS = 5_000;
const HEALTH_POLL_MS = 5_000;
const COMPLETED_PAGE_SIZE = 50;

export default function PaperTradingTab() {
  const dataSource = getPaperDataSource();
  const isMock = dataSource.kind === 'mock';

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // --- Account (poll as a WS-independent backstop) ---
  const account = useAbortableQuery(['account'], (signal) => dataSource.getAccount(signal));
  useEffect(() => {
    const t = setInterval(account.refetch, ACCOUNT_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch identity is stable (useCallback)
  }, []);

  // --- Runtime Health ---
  const health = useAbortableQuery(['health'], (signal) => dataSource.getHealth(signal));
  useEffect(() => {
    const t = setInterval(health.refetch, HEALTH_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Current Trades ---
  const currentTrades = useAbortableQuery(['current-trades'], (signal) => dataSource.getCurrentTrades(signal));

  // --- Completed Trades (server-side cursor pagination) ---
  const [completedFilter, setCompletedFilter] = useState<CompletedFinalStatusFilter>('ALL');
  const [completedCursor, setCompletedCursor] = useState<string | null>(null);
  const completedTrades = useAbortableQuery(
    ['completed-trades', completedFilter, completedCursor],
    (signal) =>
      dataSource.getCompletedTrades({ finalStatus: completedFilter, cursor: completedCursor, limit: COMPLETED_PAGE_SIZE }, signal),
  );

  function handleFilterChange(filter: CompletedFinalStatusFilter) {
    setCompletedFilter(filter);
    setCompletedCursor(null);
  }

  // --- Selected trade (Trade Detail) ---
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const tradeDetail = useAbortableQuery(
    ['trade', selectedTradeId],
    (signal) => {
      if (!selectedTradeId) return Promise.resolve(undefined);
      return dataSource.getTradeDetail(selectedTradeId, signal);
    },
  );
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const tradeEvents = useAbortableQuery(
    ['trade-events', selectedTradeId, eventsCursor],
    (signal) => {
      if (!selectedTradeId) return Promise.resolve({ items: [], next_cursor: null });
      return dataSource.getTradeEvents(selectedTradeId, { cursor: eventsCursor }, signal);
    },
  );

  // --- Live event stream (invalidation-only; UI never derives state from it) ---
  const eventStream = usePaperEventStream({
    source: isMock
      ? { kind: 'mock', events: FIXTURE_GLOBAL_EVENTS.map((e, i) => ({ ...e, seq: i + 1 })) }
      : {
          kind: 'live',
          url: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/paper`,
          getEventsAfter: (afterSeq, signal, limit) => dataSource.getEventsAfter(afterSeq, signal, limit),
        },
    onTradeEvent: (tradeId) => {
      currentTrades.refetch();
      completedTrades.refetch();
      account.refetch();
      if (tradeId === selectedTradeId) {
        tradeDetail.refetch();
        tradeEvents.refetch();
      }
    },
  });

  return (
    <div className="space-y-4">
      {isMock && <MockDataBanner />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AccountPanel account={account.data} error={account.error} nowMs={now} mock={isMock} />
        <RuntimeHealthPanel health={health.data} error={health.error} nowMs={now} mock={isMock} />
      </div>

      <CurrentTradesTable
        trades={currentTrades.data?.items ?? []}
        onSelect={(id) => {
          setSelectedTradeId(id);
          setEventsCursor(null);
        }}
        mock={isMock}
      />

      <CompletedTradesTable
        items={completedTrades.data?.items ?? []}
        filter={completedFilter}
        onFilterChange={handleFilterChange}
        hasNextPage={completedTrades.data?.next_cursor !== null && completedTrades.data?.next_cursor !== undefined}
        onLoadNextPage={() => setCompletedCursor(completedTrades.data?.next_cursor ?? null)}
        onSelect={(id) => {
          setSelectedTradeId(id);
          setEventsCursor(null);
        }}
        mock={isMock}
      />

      {selectedTradeId && tradeDetail.data && (
        <TradeDetail
          detail={tradeDetail.data}
          events={tradeEvents.data?.items ?? []}
          onClose={() => setSelectedTradeId(null)}
          onLoadMoreEvents={() => setEventsCursor(tradeEvents.data?.next_cursor ?? null)}
          hasMoreEvents={!!tradeEvents.data?.next_cursor}
        />
      )}

      <EventStreamPanel events={eventStream.events} status={eventStream.status} mock={isMock} />

      <KillSwitchPlaceholder killSwitchStatus={health.data?.kill_switch} />
    </div>
  );
}
