import { describe, expect, it } from 'vitest';
import type { PaperOrder } from '../types/order';
import type { Fill } from '../types/fill';
import type { PaperPosition } from '../types/account';
import type { Trade } from '../types/trade';
import { DEFAULT_RECONCILIATION_CONFIG } from './types';
import {
  checkOrderFillSum,
  checkOrderAvgPrice,
  checkOrderRemaining,
  checkOrderStateQty,
  checkOrderTerminalTime,
  checkOrderOrphanCreated,
  checkPositionFillNet,
  checkTradeClosedNotFlat,
  checkTradeHedgedFlat,
  checkProjectionEvent,
} from './checks';

const CFG = DEFAULT_RECONCILIATION_CONFIG;

function order(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    order_id: 'o1',
    client_order_id: 'c1',
    trade_id: 't1',
    leg_id: 'l1',
    purpose: 'ENTRY',
    exchange: 'E1' as never,
    symbol: 'BTCUSDT',
    order_type: 'MARKET',
    side: 'BUY',
    position_side: 'LONG',
    reduce_only: false,
    requested_quantity: 1000,
    requested_notional_usdt: 50_000,
    reference_price: 50,
    order_state: 'FILLED',
    created_at: 1000,
    updated_at: 1000,
    terminal_time: 1000,
    filled_quantity: 1000,
    remaining_quantity: 0,
    average_fill_price: 50,
    estimated_fee_usdt: 1,
    estimated_slippage_pct: 0,
    ...overrides,
  };
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    fill_id: 'f1',
    order_id: 'o1',
    trade_id: 't1',
    leg_id: 'l1',
    exchange: 'E1' as never,
    timestamp: 1000,
    recorded_at: 1000,
    created_at: 1000,
    updated_at: 1000,
    quantity: 900,
    price: 50,
    notional_usdt: 45_000,
    fee_usdt: 1,
    fee_asset: 'USDT',
    liquidity: 'SIMULATED',
    slippage_from_reference_pct: 0,
    ...overrides,
  };
}

describe('checkOrderFillSum (tech spec §31: "1000 vs 900" example)', () => {
  it('flags a mismatch when order.filled_quantity (1000) disagrees with sum(fills.quantity) (900)', () => {
    const o = order({ filled_quantity: 1000 });
    const fills = [fill({ quantity: 900 })];
    const mismatches = checkOrderFillSum(o, fills, CFG);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ check_id: 'ORDER_FILL_SUM', entity_id: 'o1', trade_id: 't1' });
    expect(mismatches[0].details).toContain('1000');
    expect(mismatches[0].details).toContain('900');
  });

  it('passes when order.filled_quantity agrees with sum(fills.quantity) within epsilon', () => {
    const o = order({ filled_quantity: 900 });
    const fills = [fill({ quantity: 500 }), fill({ fill_id: 'f2', quantity: 400 })];
    expect(checkOrderFillSum(o, fills, CFG)).toEqual([]);
  });
});

describe('checkOrderAvgPrice', () => {
  it('flags a mismatch when average_fill_price disagrees with the fill-quantity-weighted average', () => {
    const o = order({ filled_quantity: 900, average_fill_price: 60 });
    const fills = [fill({ quantity: 900, price: 50 })];
    const mismatches = checkOrderAvgPrice(o, fills, CFG);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].check_id).toBe('ORDER_AVG_PRICE');
  });

  it('passes when average_fill_price matches', () => {
    const o = order({ filled_quantity: 900, average_fill_price: 50 });
    const fills = [fill({ quantity: 900, price: 50 })];
    expect(checkOrderAvgPrice(o, fills, CFG)).toEqual([]);
  });
});

describe('checkOrderRemaining', () => {
  it('flags when remaining_quantity != requested - filled', () => {
    const o = order({ requested_quantity: 1000, filled_quantity: 900, remaining_quantity: 50 });
    expect(checkOrderRemaining(o, CFG)).toHaveLength(1);
  });

  it('passes when remaining_quantity = requested - filled', () => {
    const o = order({ requested_quantity: 1000, filled_quantity: 900, remaining_quantity: 100 });
    expect(checkOrderRemaining(o, CFG)).toEqual([]);
  });
});

describe('checkOrderStateQty', () => {
  it('flags a CREATED/SUBMITTED order with nonzero filled_quantity', () => {
    const o = order({ order_state: 'SUBMITTED', filled_quantity: 10, remaining_quantity: 990 });
    expect(checkOrderStateQty(o, CFG)).toHaveLength(1);
  });

  it('flags a FILLED order whose filled_quantity does not cover requested_quantity', () => {
    const o = order({ order_state: 'FILLED', requested_quantity: 1000, filled_quantity: 500, remaining_quantity: 500 });
    expect(checkOrderStateQty(o, CFG)).toHaveLength(1);
  });

  it('passes a consistent FILLED order', () => {
    const o = order({ order_state: 'FILLED', requested_quantity: 1000, filled_quantity: 1000, remaining_quantity: 0 });
    expect(checkOrderStateQty(o, CFG)).toEqual([]);
  });
});

describe('checkOrderTerminalTime', () => {
  it('flags a terminal order with no terminal_time', () => {
    const o = order({ order_state: 'FILLED', terminal_time: undefined });
    expect(checkOrderTerminalTime(o)).toHaveLength(1);
  });

  it('passes a terminal order with terminal_time set', () => {
    const o = order({ order_state: 'FILLED', terminal_time: 1234 });
    expect(checkOrderTerminalTime(o)).toEqual([]);
  });

  it('passes a non-terminal order with no terminal_time', () => {
    const o = order({ order_state: 'ACKNOWLEDGED', terminal_time: undefined });
    expect(checkOrderTerminalTime(o)).toEqual([]);
  });
});

describe('checkOrderOrphanCreated', () => {
  it('flags an order persisted in state CREATED (should never be persisted as CREATED, C-14)', () => {
    const o = order({ order_state: 'CREATED' });
    expect(checkOrderOrphanCreated(o)).toHaveLength(1);
  });

  it('passes a SUBMITTED order', () => {
    const o = order({ order_state: 'SUBMITTED' });
    expect(checkOrderOrphanCreated(o)).toEqual([]);
  });
});

function position(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    position_id: 'p1',
    trade_id: 't1',
    leg_id: 'l1',
    exchange: 'E1' as never,
    symbol: 'BTCUSDT',
    position_side: 'LONG',
    quantity: 900,
    average_entry_price: 50,
    status: 'OPEN',
    opened_at: 1000,
    created_at: 1000,
    updated_at: 1000,
    base_quantity: 900,
    entry_filled_quantity: 900,
    exit_filled_quantity: 0,
    entry_notional_usdt: 45_000,
    realized_price_pnl_usdt: 0,
    fees_usdt: 0,
    slippage_attribution_usdt: 0,
    applied_fill_ids: ['f1'],
    ...overrides,
  };
}

describe('checkPositionFillNet', () => {
  it('flags when position.quantity disagrees with entry_filled - exit_filled', () => {
    const p = position({ quantity: 1000, entry_filled_quantity: 900, exit_filled_quantity: 0 });
    expect(checkPositionFillNet(p, CFG)).toHaveLength(1);
  });

  it('passes when position.quantity equals entry_filled - exit_filled', () => {
    const p = position({ quantity: 900, entry_filled_quantity: 900, exit_filled_quantity: 0 });
    expect(checkPositionFillNet(p, CFG)).toEqual([]);
  });
});

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    trade_id: 't1',
    opportunity_id: 'opp1',
    strategy_id: 's1',
    strategy_version: 'v1',
    config_version: 'v1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    created_at: 1000,
    updated_at: 1000,
    status: 'CLOSED',
    target_notional_per_leg_usdt: 50_000,
    leverage: 1,
    allocated_margin_usdt: 50_000,
    allocated_capital_usdt: 50_000,
    legs: [],
    expected_pnl_usdt: 0,
    risk_status: { overall_status: 'PASS', checks: [] } as never,
    ...overrides,
  };
}

describe('checkTradeClosedNotFlat', () => {
  it('flags a CLOSED trade whose positions are still open (not flat)', () => {
    const t = trade({ status: 'CLOSED' });
    const positions = [position({ status: 'OPEN', quantity: 900 })];
    expect(checkTradeClosedNotFlat(t, positions, CFG)).toHaveLength(1);
  });

  it('passes a CLOSED trade whose positions are flat', () => {
    const t = trade({ status: 'CLOSED' });
    const positions = [position({ status: 'CLOSED', quantity: 0 })];
    expect(checkTradeClosedNotFlat(t, positions, CFG)).toEqual([]);
  });
});

describe('checkTradeHedgedFlat', () => {
  it('flags a HEDGED trade with no open (non-flat) positions', () => {
    const t = trade({ status: 'HEDGED' });
    const positions = [position({ status: 'CLOSED', quantity: 0 })];
    expect(checkTradeHedgedFlat(t, positions, CFG)).toHaveLength(1);
  });

  it('passes a HEDGED trade with open positions', () => {
    const t = trade({ status: 'HEDGED' });
    const positions = [position({ status: 'OPEN', quantity: 900 })];
    expect(checkTradeHedgedFlat(t, positions, CFG)).toEqual([]);
  });
});

describe('checkProjectionEvent', () => {
  it('flags when the projection status disagrees with the last recorded transition event', () => {
    const mismatches = checkProjectionEvent({
      kind: 'TRADE',
      entity_id: 't1',
      trade_id: 't1',
      projected_status: 'HEDGED',
      last_event_to: 'CLOSED',
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].check_id).toBe('PROJECTION_EVENT');
  });

  it('passes when the projection status matches the last recorded transition event', () => {
    expect(
      checkProjectionEvent({ kind: 'TRADE', entity_id: 't1', trade_id: 't1', projected_status: 'CLOSED', last_event_to: 'CLOSED' }),
    ).toEqual([]);
  });

  it('passes when there is no recorded transition event yet (nothing to compare against)', () => {
    expect(
      checkProjectionEvent({ kind: 'TRADE', entity_id: 't1', trade_id: 't1', projected_status: 'CREATED', last_event_to: null }),
    ).toEqual([]);
  });
});
