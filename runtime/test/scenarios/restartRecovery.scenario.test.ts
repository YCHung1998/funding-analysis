/**
 * runtime/test/scenarios/restartRecovery.scenario.test.ts
 *
 * Task 4.3 — restart recovery scenarios (design.md Decision 5,
 * `health/recovery.ts` task 4.2): a Runtime process restarting while a
 * Trade is mid-entry vs. while already holding a hedged position must
 * recover differently. Real `Ledger`/`EventStore`/temp-dir SQLite/
 * `VirtualClock` — never a real exchange API or wall-clock sleep.
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { makeTestLedger, type TestLedgerHarness } from '../fakes/testLedger';
import { EntryHaltLatch } from '../../src/reconciliation/entryHalt';
import { recoverFromEventStore } from '../../src/health/recovery';
import type { PaperOrder } from '../../src/types';

function advanceTradeTo(harness: TestLedgerHarness, statuses: readonly string[]): void {
  let trade = harness.tradeRepo.getTrade('trade1')!;
  for (const status of statuses) {
    const result = harness.ledger.applyTradeTransition(trade, { ...trade, status: status as never, updated_at: harness.clock.now() }, `advance to ${status}`);
    trade = result.trade;
  }
}

/** `makeTestLedger` seeds `legL`/`legS` directly (no event) — move them through a real `LEG_STATUS_CHANGED` so `assertTraceability` has something to check against. */
function openLegs(harness: TestLedgerHarness): void {
  const legL = harness.tradeRepo.getTrade('trade1')!.legs.find((l) => l.leg_id === 'legL')!;
  const legS = harness.tradeRepo.getTrade('trade1')!.legs.find((l) => l.leg_id === 'legS')!;
  harness.ledger.applyLegTransition(legL, { ...legL, status: 'OPENING', updated_at: harness.clock.now() }, 'entry started');
  harness.ledger.applyLegTransition(legS, { ...legS, status: 'OPENING', updated_at: harness.clock.now() }, 'entry started');
}

function submittedOrder(trade_id: string, order_id: string, leg_id: string): PaperOrder {
  return {
    order_id,
    client_order_id: order_id,
    trade_id,
    leg_id,
    purpose: 'ENTRY',
    exchange: 'Binance',
    symbol: 'BTCUSDT',
    order_type: 'MARKET',
    side: 'BUY',
    position_side: 'LONG',
    reduce_only: false,
    requested_quantity: 10,
    requested_notional_usdt: 1000,
    reference_price: 100,
    order_state: 'SUBMITTED',
    created_at: 0,
    updated_at: 0,
    submit_time: 0,
    filled_quantity: 0,
    remaining_quantity: 10,
    estimated_fee_usdt: 0.5,
    estimated_slippage_pct: 0.01,
  };
}

describe('restart recovery scenarios (tasks.md 4.3)', () => {
  it('restart while entering: SUBMITTED order rejected, Trade -> FAILED, entry halted', () => {
    const harness = makeTestLedger({ start: 0 });
    const entryHalt = new EntryHaltLatch(harness.eventStore, harness.clock);
    const settlementHandoff = { registered: [] as unknown[], registerRecoveredTrade: (t: unknown) => settlementHandoff.registered.push(t) };

    openLegs(harness);
    advanceTradeTo(harness, ['PRE_FLIGHT', 'ENTRY_PENDING']);
    harness.orderRepo.saveOrder(submittedOrder('trade1', 'o1', 'legL'));

    // Simulate the Runtime process restarting here (no in-memory matching state survives).
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
    expect(result.closedOrders).toEqual(['o1']);
    expect(harness.orderRepo.getOrder('o1')!.order_state).toBe('REJECTED');
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('FAILED');
    expect(entryHalt.isHalted()).toBe(true);
    expect(settlementHandoff.registered).toEqual([]);

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('restart while holding a position: HEDGED Trade handed to settlement, not failed, no entry halt', () => {
    const harness = makeTestLedger({ start: 0 });
    const entryHalt = new EntryHaltLatch(harness.eventStore, harness.clock);
    const settlementHandoff = { registered: [] as { trade_id: string }[], registerRecoveredTrade: (t: { trade_id: string }) => settlementHandoff.registered.push(t) };

    openLegs(harness);
    advanceTradeTo(harness, ['PRE_FLIGHT', 'ENTRY_PENDING', 'HEDGED']);

    // Simulate the Runtime process restarting here.
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
    expect(settlementHandoff.registered.map((t) => t.trade_id)).toEqual(['trade1']);
    expect(entryHalt.isHalted()).toBe(false);

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
