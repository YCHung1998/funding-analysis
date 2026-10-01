/**
 * runtime/src/storage/eventStore.replay.test.ts
 *
 * Task 3.2 — `replay` and `rebuildProjections` verified against tech spec
 * §43 (full successful trade) and §44 (no-fill trade): rebuilt rows must
 * equal the original rows (spec "Replay and projection rebuild").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountSnapshot, Fill, Opportunity, PaperOrder, PaperPosition, Trade, TradeLeg } from '../types';
import { VirtualClock } from '../clock/virtualClock';
import { createAccountRepository } from './accountRepository';
import { NodeSqliteDriver } from './driver';
import { EventStore } from './eventStore';
import { migrate } from './migrate';
import { migration001 } from './migrations/001_initial';
import { createOrderRepository } from './orderRepository';
import { createTradeRepository } from './tradeRepository';
import { tmpDriver } from './test-helpers';

function freshDb(): NodeSqliteDriver {
  const db = tmpDriver();
  migrate(db, [migration001]);
  return db;
}

const RISK_PASS = {
  overall_status: 'PASS' as const,
  checks: [],
  failed_reasons: [],
  leg_imbalance_detected: false,
  action_recommendation: 'PROCEED_TRADE' as const,
};

describe('EventStore replay / rebuildProjections', () => {
  let sourceDb: NodeSqliteDriver;
  let targetDb: NodeSqliteDriver;
  let clock: VirtualClock;
  let store: EventStore;

  beforeEach(() => {
    sourceDb = freshDb();
    targetDb = freshDb();
    clock = new VirtualClock(1_000);
    store = new EventStore(sourceDb, clock);
  });

  afterEach(() => {
    sourceDb.close();
    targetDb.close();
  });

  it('tech spec §43 full-success trade: every rebuilt row equals the original row', () => {
    const tradeRepo = createTradeRepository(sourceDb);
    const orderRepo = createOrderRepository(sourceDb);
    const accountRepo = createAccountRepository(sourceDb);

    const opportunity: Opportunity = {
      opportunity_id: 'opp1',
      symbol: 'BTCUSDT',
      created_at: 1000,
      detected_at: 1000,
      expires_at: 2000,
      updated_at: 1000,
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      long_funding_rate: 0.0001,
      short_funding_rate: 0.0002,
      funding_spread: 0.0001,
      long_funding_time: 5000,
      short_funding_time: 5000,
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
      status: 'SELECTED',
    };

    const legLong: TradeLeg = {
      leg_id: 'leg1',
      trade_id: 'trade1',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      direction: 'LONG',
      order_side: 'BUY',
      leverage: 1,
      target_notional_usdt: 1000,
      target_quantity: 0.1,
      actual_notional_usdt: 1000,
      actual_quantity: 0.1,
      margin_allocated_usdt: 100,
      target_entry_price: 10000,
      average_entry_price: 10000,
      average_exit_price: 10050,
      entry_order_ids: ['order1'],
      exit_order_ids: ['order3'],
      status: 'CLOSED',
      created_at: 1000,
      updated_at: 2000,
    };
    const legShort: TradeLeg = {
      leg_id: 'leg2',
      trade_id: 'trade1',
      exchange: 'Bybit',
      symbol: 'BTCUSDT',
      direction: 'SHORT',
      order_side: 'SELL',
      leverage: 1,
      target_notional_usdt: 1000,
      target_quantity: 0.1,
      actual_notional_usdt: 1000,
      actual_quantity: 0.1,
      margin_allocated_usdt: 100,
      target_entry_price: 10010,
      average_entry_price: 10010,
      average_exit_price: 10060,
      entry_order_ids: ['order2'],
      exit_order_ids: ['order4'],
      status: 'CLOSED',
      created_at: 1000,
      updated_at: 2000,
    };

    const trade: Trade = {
      trade_id: 'trade1',
      opportunity_id: 'opp1',
      strategy_id: 'strat1',
      strategy_version: 'v1',
      config_version: 'c1',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      created_at: 1000,
      updated_at: 2000,
      entry_started_at: 1000,
      entry_completed_at: 1100,
      exit_started_at: 1900,
      exit_completed_at: 2000,
      status: 'CLOSED',
      close_reason: 'NORMAL_EXIT',
      target_notional_per_leg_usdt: 1000,
      leverage: 1,
      allocated_margin_usdt: 200,
      allocated_capital_usdt: 2000,
      legs: [legLong, legShort],
      expected_pnl_usdt: 5,
      realized_pnl_usdt: 4.5,
      risk_status: RISK_PASS,
    };

    const order1: PaperOrder = {
      order_id: 'order1',
      client_order_id: 'c1',
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
      order_state: 'FILLED',
      created_at: 1000,
      updated_at: 1050,
      submit_time: 1010,
      ack_time: 1020,
      first_fill_time: 1050,
      final_fill_time: 1050,
      terminal_time: 1050,
      filled_quantity: 0.1,
      remaining_quantity: 0,
      average_fill_price: 10000,
      estimated_fee_usdt: 0.5,
      actual_fee_usdt: 0.5,
      estimated_slippage_pct: 0.0001,
      actual_slippage_pct: 0.0001,
    };
    const order2: PaperOrder = {
      ...order1,
      order_id: 'order2',
      client_order_id: 'c2',
      leg_id: 'leg2',
      exchange: 'Bybit',
      side: 'SELL',
      position_side: 'SHORT',
      reference_price: 10010,
      average_fill_price: 10010,
    };
    const order3: PaperOrder = {
      ...order1,
      order_id: 'order3',
      client_order_id: 'c3',
      purpose: 'EXIT',
      reduce_only: true,
      side: 'SELL',
      reference_price: 10050,
      average_fill_price: 10050,
      created_at: 1900,
      updated_at: 1950,
      submit_time: 1910,
      ack_time: 1920,
      first_fill_time: 1950,
      final_fill_time: 1950,
      terminal_time: 1950,
    };
    const order4: PaperOrder = {
      ...order2,
      order_id: 'order4',
      client_order_id: 'c4',
      purpose: 'EXIT',
      reduce_only: true,
      side: 'BUY',
      reference_price: 10060,
      average_fill_price: 10060,
      created_at: 1900,
      updated_at: 1960,
      submit_time: 1910,
      ack_time: 1925,
      first_fill_time: 1960,
      final_fill_time: 1960,
      terminal_time: 1960,
    };

    const fill1: Fill = {
      fill_id: 'fill1',
      order_id: 'order1',
      trade_id: 'trade1',
      leg_id: 'leg1',
      exchange: 'Binance',
      timestamp: 1050,
      recorded_at: 1050,
      created_at: 1050,
      updated_at: 1050,
      quantity: 0.1,
      price: 10000,
      notional_usdt: 1000,
      fee_usdt: 0.5,
      fee_asset: 'USDT',
      liquidity: 'TAKER',
      slippage_from_reference_pct: 0,
    };
    const fill2: Fill = { ...fill1, fill_id: 'fill2', order_id: 'order2', leg_id: 'leg2', exchange: 'Bybit', price: 10010 };
    const fill3: Fill = { ...fill1, fill_id: 'fill3', order_id: 'order3', timestamp: 1950, recorded_at: 1950, created_at: 1950, updated_at: 1950, price: 10050 };
    const fill4: Fill = { ...fill2, fill_id: 'fill4', order_id: 'order4', timestamp: 1960, recorded_at: 1960, created_at: 1960, updated_at: 1960, price: 10060 };

    const positionLongOpen: PaperPosition = {
      position_id: 'pos1',
      trade_id: 'trade1',
      leg_id: 'leg1',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      position_side: 'LONG',
      quantity: 0.1,
      average_entry_price: 10000,
      status: 'OPEN',
      opened_at: 1050,
      created_at: 1050,
      updated_at: 1050,
    };
    const positionShortOpen: PaperPosition = { ...positionLongOpen, position_id: 'pos2', leg_id: 'leg2', exchange: 'Bybit', position_side: 'SHORT', average_entry_price: 10010 };
    const positionLongClosed: PaperPosition = { ...positionLongOpen, status: 'CLOSED', closed_at: 1950, updated_at: 1950 };
    const positionShortClosed: PaperPosition = { ...positionShortOpen, status: 'CLOSED', closed_at: 1960, updated_at: 1960 };

    const snapshotReserved: AccountSnapshot = {
      snapshot_id: 'snap1',
      mode: 'PAPER',
      snapshot_time: 1000,
      total_capital_usdt: 10000,
      reserved_capital_usdt: 2000,
      available_capital_usdt: 8000,
      used_margin_usdt: 200,
      realized_pnl_usdt: 0,
      open_trade_count: 1,
      reason: 'CAPITAL_RESERVED',
      trade_id: 'trade1',
      config_version: 'c1',
      created_at: 1000,
      updated_at: 1000,
    };

    // Save the "original" projection rows directly (what the Ledger would
    // have committed synchronously alongside these events).
    tradeRepo.saveOpportunity(opportunity);
    tradeRepo.saveTrade(trade);
    orderRepo.saveOrder(order1);
    orderRepo.saveOrder(order2);
    orderRepo.saveOrder(order3);
    orderRepo.saveOrder(order4);
    orderRepo.saveFill(fill1);
    orderRepo.saveFill(fill2);
    orderRepo.saveFill(fill3);
    orderRepo.saveFill(fill4);
    orderRepo.savePosition(positionLongClosed);
    orderRepo.savePosition(positionShortClosed);
    accountRepo.saveAccountSnapshot(snapshotReserved);

    // Append the event sequence from tech spec §43, each carrying the
    // entity snapshot after that step.
    store.append({ event_id: 'e1', event_type: 'OPPORTUNITY_DETECTED', timestamp: 1000, trade_id: null, payload: { after: opportunity } });
    store.append({ event_id: 'e2', event_type: 'CAPITAL_RESERVED', timestamp: 1000, trade_id: 'trade1', payload: { snapshot: snapshotReserved } });
    store.append({ event_id: 'e3', event_type: 'TRADE_CREATED', timestamp: 1000, trade_id: 'trade1', payload: { after: { ...trade, status: 'CREATED' } } });
    store.append({ event_id: 'e4', event_type: 'ORDER_CREATED', timestamp: 1000, trade_id: 'trade1', order_id: 'order1', payload: { after: { ...order1, order_state: 'CREATED' } } });
    store.append({ event_id: 'e5', event_type: 'ORDER_CREATED', timestamp: 1000, trade_id: 'trade1', order_id: 'order2', payload: { after: { ...order2, order_state: 'CREATED' } } });
    store.append({ event_id: 'e6', event_type: 'ORDER_SUBMITTED', timestamp: 1010, trade_id: 'trade1', order_id: 'order1', payload: { after: { ...order1, order_state: 'SUBMITTED' } } });
    store.append({ event_id: 'e7', event_type: 'ORDER_SUBMITTED', timestamp: 1010, trade_id: 'trade1', order_id: 'order2', payload: { after: { ...order2, order_state: 'SUBMITTED' } } });
    store.append({ event_id: 'e8', event_type: 'ORDER_ACK', timestamp: 1020, trade_id: 'trade1', order_id: 'order1', payload: { after: { ...order1, order_state: 'ACKNOWLEDGED' } } });
    store.append({ event_id: 'e9', event_type: 'ORDER_ACK', timestamp: 1020, trade_id: 'trade1', order_id: 'order2', payload: { after: { ...order2, order_state: 'ACKNOWLEDGED' } } });
    store.append({ event_id: 'e10', event_type: 'ORDER_FILL', timestamp: 1050, trade_id: 'trade1', order_id: 'order1', payload: { after: order1, fill: fill1 } });
    store.append({ event_id: 'e11', event_type: 'ORDER_FILL', timestamp: 1050, trade_id: 'trade1', order_id: 'order2', payload: { after: order2, fill: fill2 } });
    store.append({ event_id: 'e12', event_type: 'POSITION_OPENED', timestamp: 1050, trade_id: 'trade1', position_id: 'pos1', payload: { after: positionLongOpen } });
    store.append({ event_id: 'e13', event_type: 'POSITION_OPENED', timestamp: 1050, trade_id: 'trade1', position_id: 'pos2', payload: { after: positionShortOpen } });
    store.append({ event_id: 'e14', event_type: 'TRADE_STATUS_CHANGED', timestamp: 1050, trade_id: 'trade1', payload: { after: { ...trade, status: 'HEDGED', realized_pnl_usdt: undefined } } });
    store.append({ event_id: 'e15', event_type: 'FUNDING_SETTLED', timestamp: 1500, trade_id: 'trade1', payload: {} });
    store.append({ event_id: 'e16', event_type: 'TRADE_STATUS_CHANGED', timestamp: 1900, trade_id: 'trade1', payload: { after: { ...trade, status: 'EXIT_PENDING', realized_pnl_usdt: undefined } } });
    store.append({ event_id: 'e17', event_type: 'ORDER_CREATED', timestamp: 1900, trade_id: 'trade1', order_id: 'order3', payload: { after: { ...order3, order_state: 'CREATED' } } });
    store.append({ event_id: 'e18', event_type: 'ORDER_CREATED', timestamp: 1900, trade_id: 'trade1', order_id: 'order4', payload: { after: { ...order4, order_state: 'CREATED' } } });
    store.append({ event_id: 'e19', event_type: 'ORDER_FILL', timestamp: 1950, trade_id: 'trade1', order_id: 'order3', payload: { after: order3, fill: fill3 } });
    store.append({ event_id: 'e20', event_type: 'ORDER_FILL', timestamp: 1960, trade_id: 'trade1', order_id: 'order4', payload: { after: order4, fill: fill4 } });
    store.append({ event_id: 'e21', event_type: 'POSITION_CLOSED', timestamp: 1950, trade_id: 'trade1', position_id: 'pos1', payload: { after: positionLongClosed } });
    store.append({ event_id: 'e22', event_type: 'POSITION_CLOSED', timestamp: 1960, trade_id: 'trade1', position_id: 'pos2', payload: { after: positionShortClosed } });
    store.append({ event_id: 'e23', event_type: 'TRADE_STATUS_CHANGED', timestamp: 2000, trade_id: 'trade1', payload: { after: trade } });

    store.rebuildProjections(targetDb);

    const targetTradeRepo = createTradeRepository(targetDb);
    const targetOrderRepo = createOrderRepository(targetDb);
    const targetAccountRepo = createAccountRepository(targetDb);

    expect(targetTradeRepo.getOpportunity('opp1')).toEqual(tradeRepo.getOpportunity('opp1'));
    expect(targetTradeRepo.getTrade('trade1')).toEqual(tradeRepo.getTrade('trade1'));
    expect(targetOrderRepo.getOrder('order1')).toEqual(orderRepo.getOrder('order1'));
    expect(targetOrderRepo.getOrder('order2')).toEqual(orderRepo.getOrder('order2'));
    expect(targetOrderRepo.getOrder('order3')).toEqual(orderRepo.getOrder('order3'));
    expect(targetOrderRepo.getOrder('order4')).toEqual(orderRepo.getOrder('order4'));
    expect(targetOrderRepo.listFillsForOrder('order1')).toEqual(orderRepo.listFillsForOrder('order1'));
    expect(targetOrderRepo.getPosition('pos1')).toEqual(orderRepo.getPosition('pos1'));
    expect(targetOrderRepo.getPosition('pos2')).toEqual(orderRepo.getPosition('pos2'));
    expect(targetAccountRepo.getAccountSnapshot('snap1')).toEqual(accountRepo.getAccountSnapshot('snap1'));
  });

  it('tech spec §44 no-fill trade: rebuilt trade is ABORTED/ENTRY_TIMEOUT, order CANCELED with filled_quantity 0, events in order', () => {
    const tradeRepo = createTradeRepository(sourceDb);
    const orderRepo = createOrderRepository(sourceDb);

    const opportunity: Opportunity = {
      opportunity_id: 'opp2',
      symbol: 'ETHUSDT',
      created_at: 1000,
      detected_at: 1000,
      expires_at: 2000,
      updated_at: 1000,
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      long_funding_rate: 0.0001,
      short_funding_rate: 0.0002,
      funding_spread: 0.0001,
      long_funding_time: 5000,
      short_funding_time: 5000,
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
      status: 'SELECTED',
    };
    const leg: TradeLeg = {
      leg_id: 'leg3',
      trade_id: 'trade2',
      exchange: 'Binance',
      symbol: 'ETHUSDT',
      direction: 'LONG',
      order_side: 'BUY',
      leverage: 1,
      target_notional_usdt: 500,
      target_quantity: 0.2,
      margin_allocated_usdt: 50,
      target_entry_price: 2500,
      entry_order_ids: ['order5'],
      exit_order_ids: [],
      status: 'FAILED',
      created_at: 1000,
      updated_at: 1300,
    };
    const trade: Trade = {
      trade_id: 'trade2',
      opportunity_id: 'opp2',
      strategy_id: 'strat1',
      strategy_version: 'v1',
      config_version: 'c1',
      symbol: 'ETHUSDT',
      mode: 'PAPER',
      created_at: 1000,
      updated_at: 1300,
      entry_started_at: 1000,
      status: 'ABORTED',
      target_notional_per_leg_usdt: 500,
      leverage: 1,
      allocated_margin_usdt: 50,
      allocated_capital_usdt: 500,
      legs: [leg],
      expected_pnl_usdt: 0,
      realized_pnl_usdt: 0,
      risk_status: RISK_PASS,
    };
    const order: PaperOrder = {
      order_id: 'order5',
      client_order_id: 'c5',
      trade_id: 'trade2',
      leg_id: 'leg3',
      purpose: 'ENTRY',
      exchange: 'Binance',
      symbol: 'ETHUSDT',
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 0.2,
      requested_notional_usdt: 500,
      reference_price: 2500,
      order_state: 'CANCELED',
      created_at: 1000,
      updated_at: 1300,
      submit_time: 1010,
      ack_time: 1020,
      cancel_request_time: 1250,
      cancel_ack_time: 1300,
      terminal_time: 1300,
      filled_quantity: 0,
      remaining_quantity: 0.2,
      estimated_fee_usdt: 0.25,
      estimated_slippage_pct: 0.0001,
      timeout_reason: 'ENTRY_TIMEOUT',
    };

    tradeRepo.saveOpportunity(opportunity);
    tradeRepo.saveTrade(trade);
    orderRepo.saveOrder(order);

    store.append({ event_id: 'f1', event_type: 'OPPORTUNITY_DETECTED', timestamp: 1000, trade_id: null, payload: { after: opportunity } });
    store.append({ event_id: 'f2', event_type: 'TRADE_CREATED', timestamp: 1000, trade_id: 'trade2', payload: { after: { ...trade, status: 'CREATED' } } });
    store.append({ event_id: 'f3', event_type: 'ORDER_SUBMITTED', timestamp: 1010, trade_id: 'trade2', order_id: 'order5', payload: { after: { ...order, order_state: 'SUBMITTED', filled_quantity: 0 } } });
    store.append({ event_id: 'f4', event_type: 'ORDER_ACK', timestamp: 1020, trade_id: 'trade2', order_id: 'order5', payload: { after: { ...order, order_state: 'ACKNOWLEDGED', filled_quantity: 0 } } });
    store.append({ event_id: 'f5', event_type: 'ORDER_TIMEOUT', timestamp: 1240, trade_id: 'trade2', order_id: 'order5', payload: { after: { ...order, order_state: 'ACKNOWLEDGED', filled_quantity: 0 }, reason: 'ENTRY_TIMEOUT' } });
    store.append({ event_id: 'f6', event_type: 'ORDER_CANCEL_REQUESTED', timestamp: 1250, trade_id: 'trade2', order_id: 'order5', payload: { after: { ...order, order_state: 'CANCEL_REQUESTED', filled_quantity: 0 } } });
    store.append({ event_id: 'f7', event_type: 'ORDER_CANCELED', timestamp: 1300, trade_id: 'trade2', order_id: 'order5', payload: { after: order } });
    store.append({ event_id: 'f8', event_type: 'TRADE_STATUS_CHANGED', timestamp: 1300, trade_id: 'trade2', payload: { after: trade, reason: 'ENTRY_TIMEOUT' } });

    const replayed = store.replay({ trade_id: 'trade2' });
    expect(replayed.map((e) => e.event_type)).toEqual([
      'TRADE_CREATED',
      'ORDER_SUBMITTED',
      'ORDER_ACK',
      'ORDER_TIMEOUT',
      'ORDER_CANCEL_REQUESTED',
      'ORDER_CANCELED',
      'TRADE_STATUS_CHANGED',
    ]);

    store.rebuildProjections(targetDb);
    const targetTradeRepo = createTradeRepository(targetDb);
    const targetOrderRepo = createOrderRepository(targetDb);

    const rebuiltTrade = targetTradeRepo.getTrade('trade2');
    expect(rebuiltTrade?.status).toBe('ABORTED');
    const rebuiltOrder = targetOrderRepo.getOrder('order5');
    expect(rebuiltOrder?.order_state).toBe('CANCELED');
    expect(rebuiltOrder?.filled_quantity).toBe(0);
    expect(rebuiltOrder?.timeout_reason).toBe('ENTRY_TIMEOUT');
    expect(rebuiltTrade).toEqual(tradeRepo.getTrade('trade2'));
    expect(rebuiltOrder).toEqual(orderRepo.getOrder('order5'));
  });
});
