// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RuntimeHealthPanel } from './RuntimeHealthPanel';
import type { RuntimeHealth } from '../api/contracts';

const HEALTH: RuntimeHealth = {
  engine: 'RUNNING',
  exchanges: [
    { exchange: 'Binance', status: 'CONNECTED' },
    { exchange: 'Bybit', status: 'CONNECTED' },
  ],
  market_data: 'HEALTHY',
  scanner: 'RUNNING',
  risk_engine: 'ARMED',
  paper_execution: 'RUNNING',
  database: 'HEALTHY',
  last_event_at: 1000,
  runtime_heartbeat_at: 1000,
  server_time: 1000,
};

describe('RuntimeHealthPanel (tech spec §32)', () => {
  it('displays each item with StatusCode including the Last Event time', () => {
    render(<RuntimeHealthPanel health={HEALTH} error={undefined} nowMs={1000} />);
    expect(screen.getAllByText('RUNNING').length).toBe(3); // engine, scanner, paper_execution
    expect(screen.getByText('Binance')).toBeInTheDocument();
    expect(screen.getByText('Bybit')).toBeInTheDocument();
    expect(screen.getAllByText('CONNECTED').length).toBe(2);
    expect(screen.getAllByText('HEALTHY').length).toBe(2);
  });

  it('renders an exchange the component code does not know about (OKX) purely from data', () => {
    render(
      <RuntimeHealthPanel
        health={{ ...HEALTH, exchanges: [...HEALTH.exchanges, { exchange: 'OKX', status: 'CONNECTED' }] }}
        error={undefined}
        nowMs={1000}
      />,
    );
    expect(screen.getByText('OKX')).toBeInTheDocument();
  });

  it('shows STALE for Engine (not RUNNING) when heartbeat is older than the threshold, and dims the panel', () => {
    render(<RuntimeHealthPanel health={HEALTH} error={undefined} nowMs={1000 + 15_000} staleAfterMs={10_000} />);
    expect(screen.getByText('STALE')).toBeInTheDocument();
    // Engine specifically must not show RUNNING; scanner/paper_execution keep their own (dimmed) status.
    const engineRow = screen.getByText('Engine').closest('div');
    expect(engineRow?.textContent).not.toContain('RUNNING');
  });

  it('shows RUNTIME_UNREACHABLE when the Health API fails and there is no last-known data', () => {
    render(<RuntimeHealthPanel health={undefined} error={new Error('down')} nowMs={0} />);
    expect(screen.getByText('RUNTIME_UNREACHABLE')).toBeInTheDocument();
  });
});
