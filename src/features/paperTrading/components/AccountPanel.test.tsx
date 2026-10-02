// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountPanel } from './AccountPanel';
import type { AccountSnapshot } from '../api/contracts';

const BASE_ACCOUNT: AccountSnapshot = {
  snapshot_id: 'snap-1',
  mode: 'PAPER',
  snapshot_time: 10_000,
  total_capital_usdt: 10_000,
  reserved_capital_usdt: 908,
  available_capital_usdt: 9_092,
  used_margin_usdt: 800,
  realized_pnl_usdt: 0,
  open_trade_count: 2,
  reason: 'PERIODIC',
  config_version: 'cfg-1',
  created_at: 0,
  updated_at: 10_000,
};

describe('AccountPanel (spec §27)', () => {
  it('displays account values', () => {
    render(<AccountPanel account={BASE_ACCOUNT} error={undefined} nowMs={10_500} />);
    expect(screen.getByText('10,000.00')).toBeInTheDocument();
    expect(screen.getByText('9,092.00')).toBeInTheDocument();
    expect(screen.getByText('908.00')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows STALE when now - snapshot_time exceeds the threshold', () => {
    render(<AccountPanel account={BASE_ACCOUNT} error={undefined} nowMs={10_000 + 10_001} staleAfterMs={10_000} />);
    expect(screen.getByText('STALE')).toBeInTheDocument();
  });

  it('does not show STALE within the threshold', () => {
    render(<AccountPanel account={BASE_ACCOUNT} error={undefined} nowMs={10_000 + 5_000} staleAfterMs={10_000} />);
    expect(screen.queryByText('STALE')).not.toBeInTheDocument();
  });

  it('shows RUNTIME_UNREACHABLE on error with no account yet', () => {
    render(<AccountPanel account={undefined} error={new Error('fail')} nowMs={0} />);
    expect(screen.getByText('RUNTIME_UNREACHABLE')).toBeInTheDocument();
  });

  it('shows the MOCK badge when mock=true', () => {
    render(<AccountPanel account={BASE_ACCOUNT} error={undefined} nowMs={10_000} mock />);
    expect(screen.getByText('MOCK')).toBeInTheDocument();
  });
});
