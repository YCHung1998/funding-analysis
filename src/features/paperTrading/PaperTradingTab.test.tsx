// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PaperTradingTab from './PaperTradingTab';

describe('PaperTradingTab (mock data source end-to-end, HANDOFF Invariant #7)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_PAPER_DATA_SOURCE', 'mock');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shows the MOCK DATA banner and per-block MOCK badges', async () => {
    render(<PaperTradingTab />);
    expect(screen.getByText(/MOCK DATA/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('MOCK').length).toBeGreaterThan(0));
  });

  it('loads Account, Current Trades, Completed Trades and Health from the mock fixtures', async () => {
    render(<PaperTradingTab />);
    await waitFor(() => expect(screen.getByText('10,000.00')).toBeInTheDocument()); // Account total capital
    await waitFor(() => expect(screen.getAllByText('RUNNING').length).toBeGreaterThan(0)); // Health engine
    await waitFor(() => expect(screen.getAllByText('PEPEUSDT').length).toBeGreaterThan(0)); // trades
  });

  it('opens Trade Detail when a current trade row is clicked', async () => {
    const user = userEvent.setup();
    render(<PaperTradingTab />);
    await waitFor(() => expect(screen.getAllByText('PEPEUSDT').length).toBeGreaterThan(0));
    const rows = screen.getAllByRole('button').filter((el) => el.tagName === 'TR');
    await user.click(rows[0]);
    await waitFor(() => expect(screen.getByText(/^TRADE #/)).toBeInTheDocument());
  });

  it('renders the Kill Switch placeholder as disabled with the C-16 notice', async () => {
    render(<PaperTradingTab />);
    expect(screen.getByText(/待決 C-16/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /KILL SWITCH/ })).toBeDisabled();
  });
});
