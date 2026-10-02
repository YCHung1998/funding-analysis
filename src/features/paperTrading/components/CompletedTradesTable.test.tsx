// @vitest-environment jsdom
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CompletedTradesTable } from './CompletedTradesTable';
import type { CompletedTradeSummary } from '../api/contracts';

function makeCompleted(overrides: Partial<CompletedTradeSummary>): CompletedTradeSummary {
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
    status: 'CLOSED',
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
    result: {
      trade_id: overrides.trade_id ?? 't1',
      symbol: 'PEPEUSDT',
      mode: 'PAPER',
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      target_notional_per_leg_usdt: 1000,
      actual_long_notional_usdt: 1000,
      actual_short_notional_usdt: 998,
      leverage: 3,
      entry_duration_ms: 800,
      exit_duration_ms: 600,
      total_trade_duration_ms: 3_600_000,
      funding_pnl_usdt: 3,
      price_pnl_usdt: -1.5,
      fee_usdt: 0.8,
      slippage_attribution_usdt: -1.2,
      net_pnl_usdt: 0.7,
      roi_on_capital_pct: 0.001,
      roi_on_notional_pct: 0.0007,
      max_leg_imbalance_usdt: 0,
      max_leg_imbalance_duration_ms: 0,
      final_status: 'PROFIT',
      result_reason: 'NORMAL_EXIT',
      funding_confirmed: true,
      finalized_at: 2000,
      created_at: 1000,
      updated_at: 2000,
    },
    ...overrides,
  };
}

describe('CompletedTradesTable (spec §27)', () => {
  it('shows ABORTED trades with their result_reason under the default "ALL" filter', () => {
    const profit = makeCompleted({ trade_id: 'profit-1' });
    const aborted = makeCompleted({
      trade_id: 'aborted-1',
      result: { ...profit.result, final_status: 'ABORTED', result_reason: 'ENTRY_TIMEOUT' },
    });
    render(
      <CompletedTradesTable
        items={[profit, aborted]}
        filter="ALL"
        onFilterChange={() => {}}
        hasNextPage={false}
        onLoadNextPage={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('ENTRY_TIMEOUT')).toBeInTheDocument();
    // 'ABORTED' also appears as a <option> in the filter select, so there are 2 matches.
    expect(screen.getAllByText('ABORTED').length).toBe(2);
  });

  it('calls onFilterChange when the result filter changes', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(
      <CompletedTradesTable
        items={[]}
        filter="ALL"
        onFilterChange={onFilterChange}
        hasNextPage={false}
        onLoadNextPage={() => {}}
        onSelect={() => {}}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Result'), 'EMERGENCY_EXIT');
    expect(onFilterChange).toHaveBeenCalledWith('EMERGENCY_EXIT');
  });

  it('renders only the given page (never more rows than items passed in)', () => {
    const items = Array.from({ length: 50 }, (_, i) => makeCompleted({ trade_id: `t-${i}` }));
    render(
      <CompletedTradesTable
        items={items}
        filter="ALL"
        onFilterChange={() => {}}
        hasNextPage={true}
        onLoadNextPage={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByRole('button', { hidden: true }).filter((el) => el.tagName === 'TR').length).toBe(50);
    expect(screen.getByText('載入下一頁')).toBeInTheDocument();
  });

  it('shows the funding-confirmation badge for closed trades', () => {
    const pending = makeCompleted({
      trade_id: 'pending-1',
      result: { ...makeCompleted({}).result, funding_confirmed: false, finalized_at: undefined },
    });
    render(
      <CompletedTradesTable
        items={[pending]}
        filter="ALL"
        onFilterChange={() => {}}
        hasNextPage={false}
        onLoadNextPage={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('已平倉 · 待入帳')).toBeInTheDocument();
  });

  it('opens Trade Detail (calls onSelect) when a row is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <CompletedTradesTable
        items={[makeCompleted({ trade_id: 'click-me' })]}
        filter="ALL"
        onFilterChange={() => {}}
        hasNextPage={false}
        onLoadNextPage={() => {}}
        onSelect={onSelect}
      />,
    );
    const row = screen.getByText('PEPEUSDT').closest('tr')!;
    await user.click(within(row).getByText('PEPEUSDT'));
    expect(onSelect).toHaveBeenCalledWith('click-me');
  });
});
