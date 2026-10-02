/**
 * runtime/test/scenarios/positionFundingPnl.scenario.test.ts
 *
 * Task 4.3 — Position -> FundingSettlement -> TradeResult full chain for
 * three scenarios (tech spec §42-45):
 *  - S01 Normal Full Fill (§43): both legs fill, hedge, settle, close, PROFIT/LOSS.
 *  - No-Fill ABORTED (§44): zero fills, both legs NOT_ELIGIBLE, TradeResult ABORTED.
 *  - Single-leg EMERGENCY_EXIT (§45 / S03 / S12): short leg rejected, long leg
 *    emergency-closed before settlement -> funding = 0 for the surviving leg (Q-08).
 *
 * Also exercises `Ledger.applyFill`'s atomic Position write + event (task
 * 1.3) and asserts every entity has created_at/updated_at and event
 * timestamps are monotonic non-decreasing (tech spec §42).
 */
import { describe, expect, it } from 'vitest';
import type { Fill, PaperPosition } from '../../src/types';
import { VirtualClock } from '../../src/clock/virtualClock';
import { EventStore, type StoredTradingEvent } from '../../src/storage/eventStore';
import { Ledger } from '../../src/storage/ledger';
import { migrate } from '../../src/storage/migrate';
import { migration001 } from '../../src/storage/migrations/001_initial';
import { migration002 } from '../../src/storage/migrations/002_position_accounting_fields';
import { createAccountRepository } from '../../src/storage/accountRepository';
import { createOrderRepository } from '../../src/storage/orderRepository';
import { createTradeRepository } from '../../src/storage/tradeRepository';
import { tmpDriver } from '../../src/storage/test-helpers';
import { applyFill } from '../../src/trading/positionManager';
import { computeHedgeRatio, classifyHedge, INITIAL_LEG_IMBALANCE_STATE, updateLegImbalance } from '../../src/trading/hedgeRatio';
import { fundingAmount } from '../../src/trading/fundingAmount';
import { assembleTradeResult, type AssembleTradeResultInput } from '../../src/accounting/tradeResultAssembler';
import type { LegPnlInput } from '../../src/accounting/pnlEngine';

function assertMonotonicTimestamps(events: StoredTradingEvent[]): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
  }
}

function assertTimestamped(entity: { created_at: number; updated_at: number }): void {
  expect(typeof entity.created_at).toBe('number');
  expect(typeof entity.updated_at).toBe('number');
  expect(entity.updated_at).toBeGreaterThanOrEqual(entity.created_at);
}

function makeFill(overrides: Partial<Fill> & Pick<Fill, 'fill_id' | 'order_id' | 'trade_id' | 'leg_id' | 'quantity' | 'price' | 'timestamp'>): Fill {
  const notional = overrides.quantity * overrides.price;
  return {
    exchange: 'Binance',
    recorded_at: overrides.timestamp,
    created_at: overrides.timestamp,
    updated_at: overrides.timestamp,
    notional_usdt: notional,
    fee_usdt: notional * 0.0005,
    fee_asset: 'USDT',
    liquidity: 'TAKER',
    slippage_from_reference_pct: 0,
    ...overrides,
  };
}

describe('Scenario S01 — Normal Full Fill (tech spec §43)', () => {
  it('Position opens/closes atomically via Ledger.applyFill, hedges, settles both legs, finalizes PROFIT/LOSS', () => {
    const db = tmpDriver();
    migrate(db, [migration001, migration002]);
    const clock = new VirtualClock(0);
    const tradeRepo = createTradeRepository(db);
    const orderRepo = createOrderRepository(db);
    const accountRepo = createAccountRepository(db);
    const eventStore = new EventStore(db, clock);
    const uiEvents: StoredTradingEvent[] = [];
    const ledger = new Ledger(db, clock, { trade: tradeRepo, order: orderRepo, account: accountRepo }, eventStore, (e) => uiEvents.push(e));

    accountRepo.saveAccountSnapshot({
      snapshot_id: 'init',
      mode: 'PAPER',
      snapshot_time: 0,
      total_capital_usdt: 10_000,
      reserved_capital_usdt: 0,
      available_capital_usdt: 10_000,
      used_margin_usdt: 0,
      realized_pnl_usdt: 0,
      open_trade_count: 0,
      reason: 'INITIAL',
      config_version: 'c1',
      created_at: 0,
      updated_at: 0,
    });
    tradeRepo.saveOpportunity({
      opportunity_id: 'opp1',
      symbol: 'BTCUSDT',
      created_at: 0,
      detected_at: 0,
      expires_at: 10_000,
      updated_at: 0,
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      long_funding_rate: 0.0001,
      short_funding_rate: 0.0021,
      funding_spread: 0.002,
      long_funding_time: 30_000,
      short_funding_time: 30_000,
      long_funding_interval_hours: 8,
      short_funding_interval_hours: 8,
      funding_time_diff_ms: 0,
      funding_aligned: true,
      long_price: 100,
      short_price: 100,
      price_difference_pct: 0,
      estimated_fee_pct: 0.001,
      estimated_slippage_pct: 0.0005,
      estimated_funding_pnl: 2,
      estimated_net_pnl: 1,
      liquidity_score: 1,
      strategy_version: 'v1',
      status: 'SELECTED',
    });
    const RISK_PASS = { overall_status: 'PASS' as const, checks: [], failed_reasons: [], leg_imbalance_detected: false, action_recommendation: 'PROCEED_TRADE' as const };
    tradeRepo.saveTrade({
      trade_id: 'trade1',
      opportunity_id: 'opp1',
      strategy_id: 's1',
      strategy_version: 'v1',
      config_version: 'c1',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      created_at: 0,
      updated_at: 0,
      status: 'CREATED',
      target_notional_per_leg_usdt: 1000,
      leverage: 1,
      allocated_margin_usdt: 1000,
      allocated_capital_usdt: 1000,
      legs: [],
      expected_pnl_usdt: 1,
      risk_status: RISK_PASS,
    });
    tradeRepo.saveTradeLeg({
      leg_id: 'legL',
      trade_id: 'trade1',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      direction: 'LONG',
      order_side: 'BUY',
      leverage: 1,
      target_notional_usdt: 1000,
      target_quantity: 10,
      margin_allocated_usdt: 500,
      target_entry_price: 100,
      entry_order_ids: ['orderL_entry'],
      exit_order_ids: ['orderL_exit'],
      status: 'PENDING',
      created_at: 0,
      updated_at: 0,
    });
    tradeRepo.saveTradeLeg({
      leg_id: 'legS',
      trade_id: 'trade1',
      exchange: 'Bybit',
      symbol: 'BTCUSDT',
      direction: 'SHORT',
      order_side: 'SELL',
      leverage: 1,
      target_notional_usdt: 1000,
      target_quantity: 10,
      margin_allocated_usdt: 500,
      target_entry_price: 100,
      entry_order_ids: ['orderS_entry'],
      exit_order_ids: ['orderS_exit'],
      status: 'PENDING',
      created_at: 0,
      updated_at: 0,
    });

    // --- Entry fills: long leg 10 @ 100.00, short leg 10 @ 100.00 ---
    const entryFillLong = makeFill({ fill_id: 'fL1', order_id: 'orderL_entry', trade_id: 'trade1', leg_id: 'legL', exchange: 'Binance', quantity: 10, price: 100, timestamp: 100 });
    const entryOutcomeLong = applyFill({
      fill: entryFillLong,
      orderReferencePrice: 100,
      orderSide: 'BUY',
      entryOrderIds: ['orderL_entry'],
      exitOrderIds: ['orderL_exit'],
      positionSide: 'LONG',
      contractMultiplier: 1,
      now: 100,
      newPositionIdentity: { position_id: 'posL', trade_id: 'trade1', leg_id: 'legL', exchange: 'Binance', symbol: 'BTCUSDT' },
    });
    expect(entryOutcomeLong.ok).toBe(true);
    if (!entryOutcomeLong.ok) throw new Error('unreachable');

    // Atomic commit: Position + ORDER_FILL + POSITION_OPENED all in one Ledger transaction (task 1.3).
    const orderLBefore = makeOrder('orderL_entry', 'trade1', 'legL', 'ENTRY', 'Binance', 'BUY', 'LONG', 10, 100, 100, 'ACKNOWLEDGED');
    orderRepo.saveOrder(orderLBefore); // pre-exists (ORDER_ACK already committed earlier in the real flow)
    const orderLAfter = { ...orderLBefore, order_state: 'FILLED' as const, filled_quantity: 10, remaining_quantity: 0, average_fill_price: 100 };
    const commitL = ledger.applyFill({
      fill: entryFillLong,
      orderBefore: orderLBefore,
      orderAfter: orderLAfter,
      reason: 'filled',
      position: entryOutcomeLong.position,
      positionEventType: 'POSITION_OPENED',
    });
    expect(commitL.events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['ORDER_FILL', 'POSITION_OPENED']));
    const persistedPosL = orderRepo.getPosition('posL');
    expect(persistedPosL?.position_id).toBe('posL');
    expect(persistedPosL?.quantity).toBe(entryOutcomeLong.position.quantity);
    expect(persistedPosL?.base_quantity).toBe(entryOutcomeLong.position.base_quantity);
    expect(persistedPosL?.average_entry_price).toBe(entryOutcomeLong.position.average_entry_price);
    expect(persistedPosL?.applied_fill_ids).toEqual(entryOutcomeLong.position.applied_fill_ids);

    const entryFillShort = makeFill({ fill_id: 'fS1', order_id: 'orderS_entry', trade_id: 'trade1', leg_id: 'legS', exchange: 'Bybit', quantity: 10, price: 100, timestamp: 120 });
    const entryOutcomeShort = applyFill({
      fill: entryFillShort,
      orderReferencePrice: 100,
      orderSide: 'SELL',
      entryOrderIds: ['orderS_entry'],
      exitOrderIds: ['orderS_exit'],
      positionSide: 'SHORT',
      contractMultiplier: 1,
      now: 120,
      newPositionIdentity: { position_id: 'posS', trade_id: 'trade1', leg_id: 'legS', exchange: 'Bybit', symbol: 'BTCUSDT' },
    });
    if (!entryOutcomeShort.ok) throw new Error('unreachable');

    // --- Hedge ratio: fully hedged ---
    const hedge = computeHedgeRatio(
      { base_quantity: entryOutcomeLong.position.base_quantity, average_entry_price: entryOutcomeLong.position.average_entry_price },
      { base_quantity: entryOutcomeShort.position.base_quantity, average_entry_price: entryOutcomeShort.position.average_entry_price },
      'QUANTITY',
    );
    expect(hedge.hedge_ratio).toBe(1);
    expect(classifyHedge(hedge.hedge_ratio, 'BTCUSDT')).toBe('HEDGED');

    let imbalance = INITIAL_LEG_IMBALANCE_STATE;
    imbalance = updateLegImbalance(imbalance, { timestamp: 100, long: { base_quantity: 10, average_entry_price: 100 }, short: { base_quantity: 0, average_entry_price: 0 }, basis: 'QUANTITY', hedged_min: 0.99 });
    imbalance = updateLegImbalance(imbalance, { timestamp: 120, long: { base_quantity: 10, average_entry_price: 100 }, short: { base_quantity: 10, average_entry_price: 100 }, basis: 'QUANTITY', hedged_min: 0.99 });
    expect(imbalance.max_leg_imbalance_duration_ms).toBe(20); // brief gap between the two entry fills

    // --- Exit fills ---
    const exitFillLong = makeFill({ fill_id: 'fL2', order_id: 'orderL_exit', trade_id: 'trade1', leg_id: 'legL', exchange: 'Binance', quantity: 10, price: 100.3, timestamp: 2000 });
    const exitOutcomeLong = applyFill({
      fill: exitFillLong,
      orderReferencePrice: 100.3,
      orderSide: 'SELL',
      entryOrderIds: ['orderL_entry'],
      exitOrderIds: ['orderL_exit'],
      positionSide: 'LONG',
      contractMultiplier: 1,
      now: 2000,
      position: entryOutcomeLong.position,
    });
    if (!exitOutcomeLong.ok) throw new Error('unreachable');
    expect(exitOutcomeLong.event).toBe('POSITION_CLOSED');
    expect(exitOutcomeLong.position.realized_price_pnl_usdt).toBeCloseTo(3.0, 10); // (100.3-100.0)*10

    const exitFillShort = makeFill({ fill_id: 'fS2', order_id: 'orderS_exit', trade_id: 'trade1', leg_id: 'legS', exchange: 'Bybit', quantity: 10, price: 99.95, timestamp: 2010 });
    const exitOutcomeShort = applyFill({
      fill: exitFillShort,
      orderReferencePrice: 99.95,
      orderSide: 'BUY',
      entryOrderIds: ['orderS_entry'],
      exitOrderIds: ['orderS_exit'],
      positionSide: 'SHORT',
      contractMultiplier: 1,
      now: 2010,
      position: entryOutcomeShort.position,
    });
    if (!exitOutcomeShort.ok) throw new Error('unreachable');
    expect(exitOutcomeShort.position.realized_price_pnl_usdt).toBeCloseTo(0.5, 10); // (100.0-99.95)*10

    assertTimestamped(exitOutcomeLong.position);
    assertTimestamped(exitOutcomeShort.position);

    // --- FundingSettlement amounts (both legs SETTLED) ---
    const amountLong = fundingAmount('SETTLED', { side: 'LONG', quantity: 10, mark_price: 100, funding_rate: 0.0001 });
    const amountShort = fundingAmount('SETTLED', { side: 'SHORT', quantity: 10, mark_price: 100, funding_rate: 0.0021 });
    expect(amountLong.actual_cashflow_usdt).toBeCloseTo(-0.1, 10);
    expect(amountShort.actual_cashflow_usdt).toBeCloseTo(2.1, 10);

    const fundingEvent = eventStore.append({
      event_id: 'evt-funding-settled',
      event_type: 'FUNDING_SETTLED',
      timestamp: 3000,
      trade_id: 'trade1',
      payload: { legs: { legL: amountLong, legS: amountShort } },
    });

    // --- TradeResult assembly (provisional then final) ---
    const legs: LegPnlInput[] = [
      {
        realized_price_pnl_usdt: exitOutcomeLong.position.realized_price_pnl_usdt,
        fees_usdt: exitOutcomeLong.position.fees_usdt,
        slippage_attribution_usdt: exitOutcomeLong.position.slippage_attribution_usdt,
        funding_settlement_status: 'SETTLED',
        actual_cashflow_usdt: amountLong.actual_cashflow_usdt,
      },
      {
        realized_price_pnl_usdt: exitOutcomeShort.position.realized_price_pnl_usdt,
        fees_usdt: exitOutcomeShort.position.fees_usdt,
        slippage_attribution_usdt: exitOutcomeShort.position.slippage_attribution_usdt,
        funding_settlement_status: 'SETTLED',
        actual_cashflow_usdt: amountShort.actual_cashflow_usdt,
      },
    ];
    const input: AssembleTradeResultInput = {
      trade_id: 'trade1',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      target_notional_per_leg_usdt: 1000,
      actual_long_notional_usdt: 1000,
      actual_short_notional_usdt: 1000,
      leverage: 1,
      allocated_capital_usdt: 1000,
      entry_started_at: 100,
      entry_completed_at: 120,
      exit_started_at: 2000,
      exit_completed_at: 2010,
      legs,
      funding_settlement_statuses: ['SETTLED', 'SETTLED'],
      max_leg_imbalance_usdt: imbalance.max_leg_imbalance_usdt,
      max_leg_imbalance_duration_ms: imbalance.max_leg_imbalance_duration_ms,
      created_at: 2010,
      now: 3000,
    };
    const tradeResult = assembleTradeResult(input);
    assertTimestamped(tradeResult);
    expect(tradeResult.funding_confirmed).toBe(true);
    expect(tradeResult.finalized_at).toBe(3000);
    expect(tradeResult.final_status === 'PROFIT' || tradeResult.final_status === 'LOSS' || tradeResult.final_status === 'BREAK_EVEN').toBe(true);
    expect(tradeResult.net_pnl_usdt).toBeCloseTo(3.0 + 0.5 - 0.1 + 2.1 - (entryFillLong.fee_usdt + exitFillLong.fee_usdt + entryFillShort.fee_usdt + exitFillShort.fee_usdt), 6);

    const completedEvent = eventStore.append({
      event_id: 'evt-trade-completed',
      event_type: 'TRADE_COMPLETED',
      timestamp: 3000,
      trade_id: 'trade1',
      payload: { after: tradeResult },
    });

    const allEvents = eventStore.replay({ trade_id: 'trade1' });
    assertMonotonicTimestamps(allEvents);
    expect(allEvents.find((e) => e.event_id === 'evt-funding-settled')).toBeDefined();
    expect(allEvents.find((e) => e.event_id === 'evt-trade-completed')).toBeDefined();
    void fundingEvent;
    void completedEvent;

    db.close();
  });
});

describe('Scenario — No-Fill ABORTED (tech spec §44)', () => {
  it('zero fills -> no Position ever opens; both legs NOT_ELIGIBLE -> TradeResult ABORTED, net 0, ROI 0', () => {
    const legs: LegPnlInput[] = [];
    const result = assembleTradeResult({
      trade_id: 'trade2',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      target_notional_per_leg_usdt: 1000,
      actual_long_notional_usdt: 0,
      actual_short_notional_usdt: 0,
      leverage: 1,
      allocated_capital_usdt: 1000,
      legs,
      funding_settlement_statuses: ['NOT_ELIGIBLE', 'NOT_ELIGIBLE'],
      max_leg_imbalance_usdt: 0,
      max_leg_imbalance_duration_ms: 0,
      terminal_outcome: 'ABORTED',
      created_at: 1000,
      now: 1000,
    });
    assertTimestamped(result);
    expect(result.final_status).toBe('ABORTED');
    expect(result.net_pnl_usdt).toBe(0);
    expect(result.roi_on_notional_pct).toBe(0);
    expect(result.roi_on_capital_pct).toBe(0);
    expect(result.funding_confirmed).toBe(true); // both legs NOT_ELIGIBLE is a known (zero) outcome
    expect(result.finalized_at).toBe(1000);
  });
});

describe('Scenario — Single-leg EMERGENCY_EXIT (tech spec §45 / S03 / S12)', () => {
  it('short leg REJECTED -> LEG_IMBALANCE -> long leg emergency-closed before settlement -> funding 0 for the surviving leg (Q-08)', () => {
    const entryFillLong = makeFill({ fill_id: 'fL1', order_id: 'orderL_entry', trade_id: 'trade3', leg_id: 'legL', exchange: 'Binance', quantity: 10, price: 100, timestamp: 100, fee_usdt: 0.5 });
    const opened = applyFill({
      fill: entryFillLong,
      orderReferencePrice: 100,
      orderSide: 'BUY',
      entryOrderIds: ['orderL_entry'],
      exitOrderIds: ['orderL_exit'],
      positionSide: 'LONG',
      contractMultiplier: 1,
      now: 100,
      newPositionIdentity: { position_id: 'posL3', trade_id: 'trade3', leg_id: 'legL', exchange: 'Binance', symbol: 'BTCUSDT' },
    });
    if (!opened.ok) throw new Error('unreachable');

    // Short leg REJECTED: hedge ratio against an empty short leg.
    const hedge = computeHedgeRatio(
      { base_quantity: opened.position.base_quantity, average_entry_price: opened.position.average_entry_price },
      { base_quantity: 0, average_entry_price: 0 },
      'QUANTITY',
    );
    expect(classifyHedge(hedge.hedge_ratio, 'BTCUSDT')).toBe('LEG_IMBALANCE');

    let imbalance = INITIAL_LEG_IMBALANCE_STATE;
    imbalance = updateLegImbalance(imbalance, { timestamp: 100, long: { base_quantity: 10, average_entry_price: 100 }, short: { base_quantity: 0, average_entry_price: 0 }, basis: 'QUANTITY', hedged_min: 0.99 });
    // Emergency close at t=5200, well before the funding settlement time -> this leg never reaches ELIGIBLE/SETTLED.
    const emergencyCloseFill = makeFill({ fill_id: 'fL2', order_id: 'orderL_exit', trade_id: 'trade3', leg_id: 'legL', exchange: 'Binance', quantity: 10, price: 99.8, timestamp: 5200, fee_usdt: 0.5 });
    const closed = applyFill({
      fill: emergencyCloseFill,
      orderReferencePrice: 99.8,
      orderSide: 'SELL',
      entryOrderIds: ['orderL_entry'],
      exitOrderIds: ['orderL_exit'],
      positionSide: 'LONG',
      contractMultiplier: 1,
      now: 5200,
      position: opened.position,
    });
    if (!closed.ok) throw new Error('unreachable');
    expect(closed.event).toBe('POSITION_CLOSED');
    imbalance = updateLegImbalance(imbalance, { timestamp: 5200, long: { base_quantity: 0, average_entry_price: 0 }, short: { base_quantity: 0, average_entry_price: 0 }, basis: 'QUANTITY', hedged_min: 0.99 });
    expect(imbalance.max_leg_imbalance_duration_ms).toBe(5100);

    // Q-08: the surviving leg never reaches a lock window -> NOT_ELIGIBLE, funding = 0 (never "borrows" a hedge counterpart that never existed).
    const legs: LegPnlInput[] = [
      {
        realized_price_pnl_usdt: closed.position.realized_price_pnl_usdt,
        fees_usdt: closed.position.fees_usdt,
        slippage_attribution_usdt: closed.position.slippage_attribution_usdt,
        funding_settlement_status: 'NOT_ELIGIBLE',
        actual_cashflow_usdt: 0,
      },
    ];
    const result = assembleTradeResult({
      trade_id: 'trade3',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      target_notional_per_leg_usdt: 1000,
      actual_long_notional_usdt: 1000,
      actual_short_notional_usdt: 0,
      leverage: 1,
      allocated_capital_usdt: 1000,
      legs,
      funding_settlement_statuses: ['NOT_ELIGIBLE'],
      max_leg_imbalance_usdt: imbalance.max_leg_imbalance_usdt,
      max_leg_imbalance_duration_ms: imbalance.max_leg_imbalance_duration_ms,
      terminal_outcome: 'EMERGENCY_EXIT',
      created_at: 5200,
      now: 5200,
    });
    assertTimestamped(result);
    expect(result.funding_pnl_usdt).toBe(0);
    expect(result.final_status).toBe('EMERGENCY_EXIT');
    expect(result.net_pnl_usdt).toBeCloseTo(-2.0 - 1.0, 6); // (99.8-100)*10 price loss - 1.0 total fees
    // roi_on_notional uses the long-only actual notional (short never filled).
    expect(result.roi_on_notional_pct).toBeCloseTo((result.net_pnl_usdt / 1000) * 100, 10);
  });
});

function makeOrder(
  order_id: string,
  trade_id: string,
  leg_id: string,
  purpose: 'ENTRY' | 'EXIT' | 'EMERGENCY_CLOSE',
  exchange: 'Binance' | 'Bybit',
  side: 'BUY' | 'SELL',
  position_side: 'LONG' | 'SHORT',
  quantity: number,
  price: number,
  now: number,
  order_state: 'ACKNOWLEDGED',
) {
  return {
    order_id,
    client_order_id: `${order_id}-c`,
    trade_id,
    leg_id,
    purpose,
    exchange,
    symbol: 'BTCUSDT',
    order_type: 'MARKET' as const,
    side,
    position_side,
    reduce_only: purpose !== 'ENTRY',
    requested_quantity: quantity,
    requested_notional_usdt: quantity * price,
    reference_price: price,
    order_state,
    created_at: now,
    updated_at: now,
    filled_quantity: 0,
    remaining_quantity: quantity,
    estimated_fee_usdt: quantity * price * 0.0005,
    estimated_slippage_pct: 0,
  };
}
