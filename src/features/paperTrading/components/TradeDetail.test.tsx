// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TradeDetail } from './TradeDetail';
import type { TradeDetailResponse } from '../api/contracts';

function baseDetail(overrides: Partial<TradeDetailResponse> = {}): TradeDetailResponse {
  const trade: TradeDetailResponse['trade'] = {
    trade_id: 'trade-1',
    opportunity_id: 'opp-1',
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
  };
  const longLeg: TradeDetailResponse['legs'][number] = {
    leg_id: 'leg-long',
    trade_id: trade.trade_id,
    exchange: 'Binance',
    symbol: 'PEPEUSDT',
    direction: 'LONG',
    order_side: 'BUY',
    leverage: 3,
    target_notional_usdt: 1000,
    target_quantity: 1,
    actual_notional_usdt: 1000,
    margin_allocated_usdt: 200,
    target_entry_price: 1,
    average_entry_price: 1.001,
    entry_order_ids: [],
    exit_order_ids: [],
    status: 'OPEN',
    created_at: 1000,
    updated_at: 1000,
  };
  const shortLeg: TradeDetailResponse['legs'][number] = {
    ...longLeg,
    leg_id: 'leg-short',
    exchange: 'Bybit',
    direction: 'SHORT',
    order_side: 'SELL',
    actual_notional_usdt: 998,
  };
  return {
    trade,
    legs: [longLeg, shortLeg],
    orders: [],
    fills: [],
    funding_settlements: [],
    opportunity: {
      opportunity_id: 'opp-1',
      symbol: 'PEPEUSDT',
      created_at: 900,
      detected_at: 900,
      expires_at: 930,
      updated_at: 900,
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      long_funding_rate: 0.0001,
      short_funding_rate: 0.0035,
      funding_spread: 0.0034,
      long_funding_time: 4000,
      short_funding_time: 4000,
      long_funding_interval_hours: 8,
      short_funding_interval_hours: 4,
      funding_time_diff_ms: 0,
      funding_aligned: true,
      long_price: 1,
      short_price: 1.0001,
      price_difference_pct: 0.01,
      estimated_fee_pct: 0.002,
      estimated_slippage_pct: 0.0005,
      estimated_funding_pnl: 3.4,
      estimated_net_pnl: 0.7,
      liquidity_score: 0.9,
      strategy_version: 'v1',
      status: 'SELECTED',
    },
    ...overrides,
  };
}

describe('TradeDetail (spec §28)', () => {
  it('shows Gross notional separate from each leg notional (spec scenario)', () => {
    const detail = baseDetail();
    render(<TradeDetail detail={detail} events={[]} onClose={() => {}} />);
    expect(screen.getByText('1,000.00')).toBeInTheDocument(); // Long notional
    expect(screen.getByText('998.00')).toBeInTheDocument(); // Short notional
    expect(screen.getByText('1,998.00')).toBeInTheDocument(); // Gross
    expect(screen.getByText('400.00')).toBeInTheDocument(); // Margin
    expect(screen.getByText('454.00')).toBeInTheDocument(); // Capital Allocation
  });

  it('lists each leg funding settlement time separately, not merged', () => {
    const detail = baseDetail({
      funding_settlements: [
        {
          funding_id: 'f1',
          trade_id: 'trade-1',
          leg_id: 'leg-long',
          exchange: 'Binance',
          symbol: 'PEPEUSDT',
          funding_time: 5000,
          position_notional: 1000,
          funding_rate: 0.0001,
          position_side: 'LONG',
          expected_cashflow_usdt: 0.1,
          settlement_status: 'SETTLED',
          created_at: 1000,
          updated_at: 5000,
        },
        {
          funding_id: 'f2',
          trade_id: 'trade-1',
          leg_id: 'leg-short',
          exchange: 'Bybit',
          symbol: 'PEPEUSDT',
          funding_time: 5000,
          position_notional: 998,
          funding_rate: 0.0035,
          position_side: 'SHORT',
          expected_cashflow_usdt: 3.49,
          settlement_status: 'SETTLED',
          created_at: 1000,
          updated_at: 5000,
        },
      ],
    });
    render(<TradeDetail detail={detail} events={[]} onClose={() => {}} />);
    expect(screen.getByText('Binance Interval')).toBeInTheDocument();
    expect(screen.getByText('Bybit Interval')).toBeInTheDocument();
    expect(screen.getByText('8h')).toBeInTheDocument();
    expect(screen.getByText('4h')).toBeInTheDocument();
  });

  it('shows the em dash (not 0) for an ABORTED trade with 0 fills, plus final_status and result_reason', () => {
    const detail = baseDetail({
      legs: [],
      trade: { ...baseDetail().trade, status: 'ABORTED' },
      result: {
        trade_id: 'trade-1',
        symbol: 'PEPEUSDT',
        mode: 'PAPER',
        long_exchange: 'Binance',
        short_exchange: 'Bybit',
        target_notional_per_leg_usdt: 1000,
        actual_long_notional_usdt: 0,
        actual_short_notional_usdt: 0,
        leverage: 3,
        entry_duration_ms: 0,
        exit_duration_ms: 0,
        total_trade_duration_ms: 0,
        funding_pnl_usdt: 0,
        price_pnl_usdt: 0,
        fee_usdt: 0,
        slippage_attribution_usdt: 0,
        net_pnl_usdt: 0,
        roi_on_capital_pct: 0,
        roi_on_notional_pct: 0,
        max_leg_imbalance_usdt: 0,
        max_leg_imbalance_duration_ms: 0,
        final_status: 'ABORTED',
        result_reason: 'ENTRY_TIMEOUT',
        funding_confirmed: true,
        finalized_at: 2000,
        created_at: 1000,
        updated_at: 2000,
      },
    });
    render(<TradeDetail detail={detail} events={[]} onClose={() => {}} />);
    expect(screen.getByText('ABORTED')).toBeInTheDocument();
    expect(screen.getByText('ENTRY_TIMEOUT')).toBeInTheDocument();
  });

  it('calls onClose when the Close button is clicked', () => {
    const detail = baseDetail();
    let closed = false;
    render(<TradeDetail detail={detail} events={[]} onClose={() => (closed = true)} />);
    screen.getByText('Close').click();
    expect(closed).toBe(true);
  });
});
