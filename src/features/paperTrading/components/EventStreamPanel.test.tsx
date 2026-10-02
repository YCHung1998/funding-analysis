// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventStreamPanel } from './EventStreamPanel';
import type { SeqEvent } from '../hooks/usePaperEventStream';

describe('EventStreamPanel (tech spec §34)', () => {
  it('formats an ORDER_FILL event as HH:mm:ss.SSS [FILL] ... 100% (spec scenario)', () => {
    const events: SeqEvent[] = [
      {
        event_id: 'e1',
        event_type: 'ORDER_FILL',
        trade_id: 't1',
        exchange: 'Binance',
        timestamp: Date.UTC(2024, 0, 1, 15, 31, 2, 130),
        recorded_at: Date.UTC(2024, 0, 1, 15, 31, 2, 130),
        payload: { fill_pct: 1 },
        seq: 1,
      },
    ];
    render(<EventStreamPanel events={events} status="CONNECTED" />);
    expect(screen.getByText(/15:31:02\.130 \[FILL\] ORDER_FILL Binance 100%/)).toBeInTheDocument();
  });

  it('shows the connection status', () => {
    render(<EventStreamPanel events={[]} status="RECONNECTING" />);
    expect(screen.getByText('RECONNECTING')).toBeInTheDocument();
  });

  it('shows the MOCK badge when mock=true', () => {
    render(<EventStreamPanel events={[]} status="CONNECTED" mock />);
    expect(screen.getByText('MOCK')).toBeInTheDocument();
  });
});
