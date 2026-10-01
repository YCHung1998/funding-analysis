// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TradeTimeline, type SeqEvent } from './TradeTimeline';
import type { TradingEventType } from '../api/contracts';

function makeEvent(overrides: Partial<SeqEvent> & { event_type: TradingEventType; seq: number }): SeqEvent {
  return {
    event_id: `evt-${overrides.seq}`,
    trade_id: 't1',
    timestamp: 1000,
    recorded_at: 1000,
    payload: {},
    ...overrides,
  };
}

describe('TradeTimeline (spec §24)', () => {
  it('shows every event including timeout/cancel/reject events, in order', () => {
    const events: SeqEvent[] = [
      makeEvent({ event_type: 'ORDER_SUBMITTED', seq: 1, timestamp: 1000 }),
      makeEvent({ event_type: 'ORDER_ACK', seq: 2, timestamp: 1010 }),
      makeEvent({ event_type: 'ORDER_TIMEOUT', seq: 3, timestamp: 2000 }),
      makeEvent({ event_type: 'ORDER_CANCEL_REQUESTED', seq: 4, timestamp: 2010 }),
      makeEvent({ event_type: 'ORDER_CANCELED', seq: 5, timestamp: 2020 }),
      makeEvent({ event_type: 'TRADE_STATUS_CHANGED', seq: 6, timestamp: 2030, payload: { to: 'ABORTED' } }),
    ];
    render(<TradeTimeline events={events} tradeCreatedAt={1000} />);
    for (const type of [
      'ORDER_SUBMITTED',
      'ORDER_ACK',
      'ORDER_TIMEOUT',
      'ORDER_CANCEL_REQUESTED',
      'ORDER_CANCELED',
      'TRADE_STATUS_CHANGED',
    ]) {
      expect(screen.getByText(type)).toBeInTheDocument();
    }
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBe(6);
  });

  it('shows both event time and recorded_at when they differ', () => {
    const events: SeqEvent[] = [
      makeEvent({ event_type: 'FUNDING_SETTLED', seq: 1, timestamp: 1000, recorded_at: 1035 }),
    ];
    render(<TradeTimeline events={events} tradeCreatedAt={1000} />);
    expect(screen.getByText(/recorded_at=/)).toBeInTheDocument();
  });

  it('shows the cancel-reject reason from payload for ORDER_CANCEL_REJECTED', () => {
    const events: SeqEvent[] = [
      makeEvent({
        event_type: 'ORDER_CANCEL_REJECTED',
        seq: 1,
        payload: { cancel_reject_reason: 'ALREADY_FILLING' },
      }),
    ];
    render(<TradeTimeline events={events} tradeCreatedAt={1000} />);
    expect(screen.getByText('ORDER_CANCEL_REJECTED')).toBeInTheDocument();
    expect(screen.getByText(/ALREADY_FILLING/)).toBeInTheDocument();
  });

  it('renders a 載入更多 button when hasMore is true and calls onLoadMore', async () => {
    const onLoadMore = vi.fn();
    render(<TradeTimeline events={[]} tradeCreatedAt={1000} hasMore onLoadMore={onLoadMore} />);
    screen.getByText('載入更多').click();
    expect(onLoadMore).toHaveBeenCalled();
  });
});
