// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CurrentTradesTable } from './CurrentTradesTable';
import type { CurrentTradeSummary } from '../api/contracts';

function makeTrade(overrides: Partial<CurrentTradeSummary>): CurrentTradeSummary {
  return {
    trade_id: 't1',
    opportunity_id: 'o1',
    strategy_id: 's1',
    strategy_version: 'v1',
    config_version: 'c1',
    symbol: 'PEPEUSDT',
    mode: 'PAPER',
    created_at: 1000,
    updated_at: 1000,
    status: 'HEDGED',
    target_notional_per_leg_usdt: 1000,
    leverage: 3,
    allocated_margin_usdt: 400,
    allocated_capital_usdt: 454,
    legs: [],
    expected_pnl_usdt: 0.7,
    risk_status: {
      overall_status: 'PASS',
      checks: [],
      failed_reasons: [],
      leg_imbalance_detected: false,
      action_recommendation: 'PROCEED_TRADE',
    },
    long_exchange: 'Binance',
    short_exchange: 'Bybit',
    hedge_ratio: 0.995,
    unrealized_pnl_usdt: 1.2,
    funding_expected_usdt: 0.4,
    ...overrides,
  };
}

describe('CurrentTradesTable (spec §27)', () => {
  it('shows the ten required columns for a trade (spec scenario)', () => {
    render(<CurrentTradesTable trades={[makeTrade({})]} onSelect={() => {}} />);
    expect(screen.getByText('1,000')).toBeInTheDocument();
    expect(screen.getByText('99.5%')).toBeInTheDocument();
    expect(screen.getByText('HEDGED')).toBeInTheDocument();
  });

  it('sorts LEG_IMBALANCE / EMERGENCY_EXIT rows first and highlights them', () => {
    const normal = makeTrade({ trade_id: 'normal', status: 'HEDGED', created_at: 5000 });
    const imbalance = makeTrade({ trade_id: 'imbalance', status: 'LEG_IMBALANCE', created_at: 1000 });
    render(<CurrentTradesTable trades={[normal, imbalance]} onSelect={() => {}} />);
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveTextContent('imbalance');
    expect(rows[0].className).toContain('bg-rose-950');
  });

  it('calls onSelect with the trade_id when a row is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CurrentTradesTable trades={[makeTrade({ trade_id: 'pick-me' })]} onSelect={onSelect} />);
    await user.click(screen.getByText('pick-me'));
    expect(onSelect).toHaveBeenCalledWith('pick-me');
  });
});
