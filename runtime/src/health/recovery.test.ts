/**
 * runtime/src/health/recovery.test.ts
 *
 * `recoverFromEventStore` (design.md Decision 5, tasks.md 4.2): restart
 * recovery closes non-terminal Orders via legal transitions (keeping filled
 * quantity), transitions in-flight entry Trades to FAILED + requests an
 * entry halt, hands HEDGED/EXIT_PENDING Trades to the settlement handoff
 * port (a fake — `settlement-session` exposes no "register existing trade"
 * interface yet, design.md Open Question 6 / Implementation Notes), and
 * flags any live-vs-rebuilt-projection mismatch via `RECONCILIATION_ERROR` +
 * entry halt.
 */
import { describe, expect, it } from 'vitest';
import { makeTestLedger, type TestLedgerHarness } from '../../test/fakes/testLedger';
import { EntryHaltLatch } from '../reconciliation/entryHalt';
import { recoverFromEventStore } from './recovery';

function harnessWithHalt(): { harness: TestLedgerHarness; entryHalt: EntryHaltLatch } {
  const harness = makeTestLedger({ start: 0 });
  const entryHalt = new EntryHaltLatch(harness.eventStore, harness.clock);
  return { harness, entryHalt };
}

function fakeSettlementHandoff() {
  const registered: string[] = [];
  return {
    registered,
    registerRecoveredTrade(trade: { trade_id: string }) {
      registered.push(trade.trade_id);
    },
  };
}

describe('recoverFromEventStore', () => {
  it('closes a SUBMITTED order via REJECTED (never acknowledged, so nothing to cancel)', () => {
    const { harness, entryHalt } = harnessWithHalt();
    const trade = harness.tradeRepo.getTrade('trade1')!;
    harness.ledger.applyTradeTransition(trade, { ...trade, status: 'PRE_FLIGHT', updated_at: 0 }, 'test setup');

    const order = {
      order_id: 'o1',
      client_order_id: 'o1',
      trade_id: 'trade1',
      leg_id: 'legL',
      purpose: 'ENTRY' as const,
      exchange: 'Binance' as const,
      symbol: 'BTCUSDT',
      order_type: 'MARKET' as const,
      side: 'BUY' as const,
      position_side: 'LONG' as const,
      reduce_only: false,
      requested_quantity: 10,
      requested_notional_usdt: 1000,
      reference_price: 100,
      order_state: 'SUBMITTED' as const,
      created_at: 0,
      updated_at: 0,
      submit_time: 0,
      filled_quantity: 0,
      remaining_quantity: 10,
      estimated_fee_usdt: 0.5,
      estimated_slippage_pct: 0.01,
    };
    harness.orderRepo.saveOrder(order);

    const settlementHandoff = fakeSettlementHandoff();
    const result = recoverFromEventStore({
      db: harness.db,
      clock: harness.clock,
      eventStore: harness.eventStore,
      ledger: harness.ledger,
      repos: { trade: harness.tradeRepo, order: harness.orderRepo },
      entryHalt,
      settlementHandoff,
    });

    expect(result.closedOrders).toEqual(['o1']);
    const after = harness.orderRepo.getOrder('o1')!;
    expect(after.order_state).toBe('REJECTED');
    expect(after.rejection_reason).toBe('RUNTIME_RESTART');
  });

  it('closes an ACKNOWLEDGED order via CANCEL_REQUESTED -> CANCELED, keeping filled_quantity', () => {
    const { harness, entryHalt } = harnessWithHalt();
    const trade = harness.tradeRepo.getTrade('trade1')!;
    harness.ledger.applyTradeTransition(trade, { ...trade, status: 'PRE_FLIGHT', updated_at: 0 }, 'test setup');

    const order = {
      order_id: 'o2',
      client_order_id: 'o2',
      trade_id: 'trade1',
      leg_id: 'legL',
      purpose: 'ENTRY' as const,
      exchange: 'Binance' as const,
      symbol: 'BTCUSDT',
      order_type: 'MARKET' as const,
      side: 'BUY' as const,
      position_side: 'LONG' as const,
      reduce_only: false,
      requested_quantity: 10,
      requested_notional_usdt: 1000,
      reference_price: 100,
      order_state: 'PARTIALLY_FILLED' as const,
      created_at: 0,
      updated_at: 0,
      submit_time: 0,
      ack_time: 1,
      filled_quantity: 4,
      remaining_quantity: 6,
      estimated_fee_usdt: 0.5,
      estimated_slippage_pct: 0.01,
    };
    harness.orderRepo.saveOrder(order);

    const settlementHandoff = fakeSettlementHandoff();
    const result = recoverFromEventStore({
      db: harness.db,
      clock: harness.clock,
      eventStore: harness.eventStore,
      ledger: harness.ledger,
      repos: { trade: harness.tradeRepo, order: harness.orderRepo },
      entryHalt,
      settlementHandoff,
    });

    expect(result.closedOrders).toEqual(['o2']);
    const after = harness.orderRepo.getOrder('o2')!;
    expect(after.order_state).toBe('CANCELED');
    expect(after.filled_quantity).toBe(4);
  });

  it('transitions an in-flight entry Trade to FAILED and requests an entry halt', () => {
    const { harness, entryHalt } = harnessWithHalt();
    const trade = harness.tradeRepo.getTrade('trade1')!;
    const preFlight = harness.ledger.applyTradeTransition(trade, { ...trade, status: 'PRE_FLIGHT', updated_at: 0 }, 'test setup').trade;
    harness.ledger.applyTradeTransition(preFlight, { ...preFlight, status: 'ENTRY_PENDING', updated_at: 0 }, 'test setup 2');

    const settlementHandoff = fakeSettlementHandoff();
    const result = recoverFromEventStore({
      db: harness.db,
      clock: harness.clock,
      eventStore: harness.eventStore,
      ledger: harness.ledger,
      repos: { trade: harness.tradeRepo, order: harness.orderRepo },
      entryHalt,
      settlementHandoff,
    });

    expect(result.failedTrades).toEqual(['trade1']);
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('FAILED');
    expect(entryHalt.isHalted()).toBe(true);
    expect(entryHalt.reasons()[0].source).toBe('RUNTIME_RECOVERY');
    expect(settlementHandoff.registered).toEqual([]);
  });

  it('hands a HEDGED Trade to the settlement handoff instead of failing it', () => {
    const { harness, entryHalt } = harnessWithHalt();
    const trade = harness.tradeRepo.getTrade('trade1')!;
    const preFlight = harness.ledger.applyTradeTransition(trade, { ...trade, status: 'PRE_FLIGHT', updated_at: 0 }, 'a').trade;
    const pending = harness.ledger.applyTradeTransition(preFlight, { ...preFlight, status: 'ENTRY_PENDING', updated_at: 0 }, 'b').trade;
    harness.ledger.applyTradeTransition(pending, { ...pending, status: 'HEDGED', updated_at: 0 }, 'c');

    const settlementHandoff = fakeSettlementHandoff();
    const result = recoverFromEventStore({
      db: harness.db,
      clock: harness.clock,
      eventStore: harness.eventStore,
      ledger: harness.ledger,
      repos: { trade: harness.tradeRepo, order: harness.orderRepo },
      entryHalt,
      settlementHandoff,
    });

    expect(result.handedToSettlement).toEqual(['trade1']);
    expect(result.failedTrades).toEqual([]);
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('HEDGED');
    expect(settlementHandoff.registered).toEqual(['trade1']);
    expect(entryHalt.isHalted()).toBe(false);
  });

  it('does not touch an already-terminal Trade (CLOSED)', () => {
    const { harness, entryHalt } = harnessWithHalt();
    const trade = harness.tradeRepo.getTrade('trade1')!;
    const preFlight = harness.ledger.applyTradeTransition(trade, { ...trade, status: 'PRE_FLIGHT', updated_at: 0 }, 'a').trade;
    const pending = harness.ledger.applyTradeTransition(preFlight, { ...preFlight, status: 'ENTRY_PENDING', updated_at: 0 }, 'b').trade;
    const hedged = harness.ledger.applyTradeTransition(pending, { ...pending, status: 'HEDGED', updated_at: 0 }, 'c').trade;
    const exitPending = harness.ledger.applyTradeTransition(hedged, { ...hedged, status: 'EXIT_PENDING', updated_at: 0 }, 'd').trade;
    harness.ledger.applyTradeTransition(exitPending, { ...exitPending, status: 'CLOSED', updated_at: 0 }, 'e');

    const settlementHandoff = fakeSettlementHandoff();
    const result = recoverFromEventStore({
      db: harness.db,
      clock: harness.clock,
      eventStore: harness.eventStore,
      ledger: harness.ledger,
      repos: { trade: harness.tradeRepo, order: harness.orderRepo },
      entryHalt,
      settlementHandoff,
    });

    expect(result.failedTrades).toEqual([]);
    expect(result.handedToSettlement).toEqual([]);
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('CLOSED');
  });

  it('detects a projection rebuild mismatch and requests an entry halt', () => {
    const { harness, entryHalt } = harnessWithHalt();
    const trade = harness.tradeRepo.getTrade('trade1')!;
    harness.ledger.applyTradeTransition(trade, { ...trade, status: 'PRE_FLIGHT', updated_at: 0 }, 'a');

    // Simulate a corrupted projection: flip the live row's status without an
    // event recording it (so the rebuilt-from-events projection disagrees).
    const corrupted = harness.tradeRepo.getTrade('trade1')!;
    harness.tradeRepo.saveTrade({ ...corrupted, status: 'HEDGED' });

    const settlementHandoff = fakeSettlementHandoff();
    const result = recoverFromEventStore({
      db: harness.db,
      clock: harness.clock,
      eventStore: harness.eventStore,
      ledger: harness.ledger,
      repos: { trade: harness.tradeRepo, order: harness.orderRepo },
      entryHalt,
      settlementHandoff,
    });

    expect(result.projectionMismatches).toBe(1);
    expect(entryHalt.isHalted()).toBe(true);
    const reasons = entryHalt.reasons();
    expect(reasons.some((r) => r.reason === 'PROJECTION_MISMATCH_AT_RESTART')).toBe(true);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const mismatchEvent = events.find((e) => e.event_type === 'RECONCILIATION_ERROR');
    expect(mismatchEvent).toBeDefined();
  });
});
