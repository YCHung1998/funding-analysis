/**
 * runtime/src/storage/orderRepository.test.ts
 *
 * Task 2.2 — lossless round trip for PaperOrder / Fill / PaperPosition /
 * FundingSettlement, and the "no delete method" guard for orders and fills.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fill, FundingSettlement, PaperOrder, PaperPosition } from '../types';
import { NodeSqliteDriver } from './driver';
import { migrate } from './migrate';
import { migration001 } from './migrations/001_initial';
import { migration002 } from './migrations/002_position_accounting_fields';
import { createOrderRepository, type OrderRepository } from './orderRepository';
import { createTradeRepository } from './tradeRepository';
import { tmpDriver } from './test-helpers';

function seedTradeAndLeg(db: NodeSqliteDriver) {
  const tradeRepo = createTradeRepository(db);
  tradeRepo.saveOpportunity({
    opportunity_id: 'opp1',
    symbol: 'BTCUSDT',
    created_at: 1,
    detected_at: 1,
    expires_at: 2,
    updated_at: 1,
    long_exchange: 'Binance',
    short_exchange: 'Bybit',
    long_funding_rate: 0.0001,
    short_funding_rate: 0.0002,
    funding_spread: 0.0001,
    long_funding_time: 1,
    short_funding_time: 1,
    long_funding_interval_hours: 8,
    short_funding_interval_hours: 8,
    funding_time_diff_ms: 0,
    funding_aligned: true,
    long_price: 100,
    short_price: 100.1,
    price_difference_pct: 0.001,
    estimated_fee_pct: 0.0005,
    estimated_slippage_pct: 0.0005,
    estimated_funding_pnl: 1,
    estimated_net_pnl: 0.5,
    liquidity_score: 0.9,
    strategy_version: 'v1',
    status: 'DETECTED',
  });
  tradeRepo.saveTrade({
    trade_id: 'trade1',
    opportunity_id: 'opp1',
    strategy_id: 's1',
    strategy_version: 'v1',
    config_version: 'c1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    created_at: 1,
    updated_at: 1,
    status: 'CREATED',
    target_notional_per_leg_usdt: 1000,
    leverage: 1,
    allocated_margin_usdt: 100,
    allocated_capital_usdt: 1000,
    legs: [
      {
        leg_id: 'leg1',
        trade_id: 'trade1',
        exchange: 'Binance',
        symbol: 'BTCUSDT',
        direction: 'LONG',
        order_side: 'BUY',
        leverage: 1,
        target_notional_usdt: 1000,
        target_quantity: 0.1,
        margin_allocated_usdt: 100,
        target_entry_price: 10000,
        entry_order_ids: [],
        exit_order_ids: [],
        status: 'PENDING',
        created_at: 1,
        updated_at: 1,
      },
    ],
    expected_pnl_usdt: 0,
    risk_status: {
      overall_status: 'PASS',
      checks: [],
      failed_reasons: [],
      leg_imbalance_detected: false,
      action_recommendation: 'PROCEED_TRADE',
    },
  });
}

function makeOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    order_id: 'order1',
    client_order_id: 'c-order1',
    trade_id: 'trade1',
    leg_id: 'leg1',
    purpose: 'ENTRY',
    exchange: 'Binance',
    symbol: 'BTCUSDT',
    order_type: 'MARKET',
    side: 'BUY',
    position_side: 'LONG',
    reduce_only: false,
    requested_quantity: 0.1,
    requested_notional_usdt: 1000,
    reference_price: 10000,
    order_state: 'CREATED',
    created_at: 1,
    updated_at: 1,
    filled_quantity: 0,
    remaining_quantity: 0.1,
    estimated_fee_usdt: 1,
    estimated_slippage_pct: 0.0005,
    ...overrides,
  };
}

describe('orderRepository', () => {
  let db: NodeSqliteDriver;
  let repo: OrderRepository;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001, migration002]);
    seedTradeAndLeg(db);
    repo = createOrderRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('PaperOrder round trips losslessly, including optional fields left undefined', () => {
    const order = makeOrder();
    repo.saveOrder(order);
    expect(repo.getOrder('order1')).toEqual(order);
  });

  it('an unfilled order ending CANCELED with filled_quantity 0 persists and stays queryable', () => {
    const order = makeOrder({
      order_state: 'CANCELED',
      filled_quantity: 0,
      remaining_quantity: 0,
      timeout_reason: 'ENTRY_TIMEOUT',
      terminal_time: 5,
    });
    repo.saveOrder(order);
    expect(repo.getOrder('order1')).toEqual(order);
  });

  it('Fill round trips losslessly', () => {
    repo.saveOrder(makeOrder());
    const fill: Fill = {
      fill_id: 'fill1',
      order_id: 'order1',
      trade_id: 'trade1',
      leg_id: 'leg1',
      exchange: 'Binance',
      timestamp: 2,
      recorded_at: 2,
      created_at: 2,
      updated_at: 2,
      quantity: 0.1,
      price: 10000,
      notional_usdt: 1000,
      fee_usdt: 1,
      fee_asset: 'USDT',
      liquidity: 'TAKER',
      slippage_from_reference_pct: 0.0001,
    };
    repo.saveFill(fill);
    expect(repo.listFillsForOrder('order1')).toEqual([fill]);
  });

  it('PaperPosition round trips losslessly', () => {
    const position: PaperPosition = {
      position_id: 'pos1',
      trade_id: 'trade1',
      leg_id: 'leg1',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      position_side: 'LONG',
      quantity: 0.1,
      average_entry_price: 10000,
      status: 'OPEN',
      opened_at: 2,
      created_at: 2,
      updated_at: 2,
      base_quantity: 0.1,
      entry_filled_quantity: 0.1,
      exit_filled_quantity: 0,
      entry_notional_usdt: 1000,
      realized_price_pnl_usdt: 0,
      fees_usdt: 0.5,
      slippage_attribution_usdt: -0.1,
      applied_fill_ids: ['fill1'],
    };
    repo.savePosition(position);
    expect(repo.getPosition('pos1')).toEqual(position);
  });

  it('FundingSettlement round trips losslessly', () => {
    const fs: FundingSettlement = {
      funding_id: 'f1',
      trade_id: 'trade1',
      leg_id: 'leg1',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      funding_time: 10,
      position_notional: 1000,
      funding_rate: 0.0001,
      position_side: 'LONG',
      expected_cashflow_usdt: 0.1,
      settlement_status: 'EXPECTED',
      created_at: 1,
      updated_at: 1,
    };
    repo.saveFundingSettlement(fs);
    expect(repo.listFundingSettlementsForLeg('leg1')).toEqual([fs]);
  });

  it('a fill referencing a non-existent order is rejected by a foreign key error', () => {
    expect(() =>
      repo.saveFill({
        fill_id: 'fill-bad',
        order_id: 'does-not-exist',
        trade_id: 'trade1',
        leg_id: 'leg1',
        exchange: 'Binance',
        timestamp: 1,
        recorded_at: 1,
        created_at: 1,
        updated_at: 1,
        quantity: 0.1,
        price: 10000,
        notional_usdt: 1000,
        fee_usdt: 1,
        fee_asset: 'USDT',
        liquidity: 'TAKER',
        slippage_from_reference_pct: 0,
      }),
    ).toThrow();
  });

  it('exposes no delete method for orders or fills', () => {
    const methodNames = Object.keys(repo);
    expect(methodNames.some((name) => /delete/i.test(name))).toBe(false);
  });
});
